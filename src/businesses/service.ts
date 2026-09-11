/**
 * Businesses service — real-table reads for the leads console.
 *
 * listBusinesses(): paginated, filtered, sortable list of businesses.
 * getBusinessDetail(): full detail for one business (NAP + source + scores +
 *   analyses + demos + rejections + lifecycle history + recent audit).
 *
 * No state changes here — writes go through the lifecycle transition service
 * (transition/reject) and the website analysis service.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, count } from 'drizzle-orm';
import { db } from '../db/client';
import {
  businesses,
  leadScores,
  websites,
  websiteAnalyses,
  demos,
  rejections,
  leadStateHistory,
  auditLogs,
} from '../db/schema';
import { legalTargets } from '../lifecycle/transitions.js';
import { isValidState } from '../lifecycle/helpers.js';
import type { LeadState } from '../lifecycle/types.js';
import type {
  BusinessListItem,
  BusinessListResponse,
  BusinessDetailResponse,
} from './types';

export const BUSINESSES_DEFAULT_PER_PAGE = 25;
export const BUSINESSES_MAX_PER_PAGE = 100;

export interface ListBusinessesQuery {
  page?: unknown;
  perPage?: unknown;
  /** Substring match on business name (case-insensitive). */
  search?: unknown;
  /** Substring match on phone (digits-tolerant: strips non-digits from the query). */
  phone?: unknown;
  industry?: unknown;
  city?: unknown;
  state?: unknown;
  lifecycleState?: unknown;
  /** 'created_at' | 'business_name' | 'rating' | 'review_count' (default created_at). */
  sort?: unknown;
  /** 'asc' | 'desc' (default desc for created_at, asc for name handled by default). */
  order?: unknown;
}

const SORT_COLUMNS = {
  created_at: businesses.created_at,
  business_name: businesses.business_name,
  rating: businesses.rating,
  review_count: businesses.review_count,
} as const;

type SortKey = keyof typeof SORT_COLUMNS;

function parsePositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Result of query parsing: filters or a 400-style validation error. */
export interface ParsedListQuery {
  page: number;
  perPage: number;
  search: string | null;
  phoneDigits: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  /** One or more lifecycle states (comma-separated on the wire). */
  lifecycleStates: LeadState[];
  sort: SortKey;
  order: 'asc' | 'desc';
}

export function parseListQuery(q: ListBusinessesQuery): ParsedListQuery | { error: string } {
  const page = parsePositiveInt(q.page, 1);
  const perPage = Math.min(parsePositiveInt(q.perPage, BUSINESSES_DEFAULT_PER_PAGE), BUSINESSES_MAX_PER_PAGE);

  if (q.lifecycleState !== undefined && q.lifecycleState !== null && String(q.lifecycleState).trim() !== '') {
    const parts = String(q.lifecycleState).split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
    const states: LeadState[] = [];
    for (const p of parts) {
      if (!isValidState(p)) {
        return { error: `invalid lifecycle state "${p}"` };
      }
      if (!states.includes(p)) states.push(p);
    }
    return finishParsed(q, states, page, perPage);
  }
  return finishParsed(q, [], page, perPage);
}

function finishParsed(
  q: ListBusinessesQuery,
  lifecycleStates: LeadState[],
  page: number,
  perPage: number,
): ParsedListQuery | { error: string } {

  const sortRaw = String(q.sort ?? 'created_at').toLowerCase();
  if (!(sortRaw in SORT_COLUMNS)) {
    return { error: `invalid sort "${q.sort}" — expected one of: created_at, business_name, rating, review_count` };
  }
  const sort = sortRaw as SortKey;

  const orderRaw = String(q.order ?? (sort === 'business_name' ? 'asc' : 'desc')).toLowerCase();
  if (orderRaw !== 'asc' && orderRaw !== 'desc') {
    return { error: `invalid order "${q.order}" — expected asc or desc` };
  }

  const search = q.search !== undefined && q.search !== null ? String(q.search).trim() : '';
  const phoneRaw = q.phone !== undefined && q.phone !== null ? String(q.phone).trim() : '';
  const industry = q.industry !== undefined && q.industry !== null ? String(q.industry).trim().toLowerCase() : '';
  const city = q.city !== undefined && q.city !== null ? String(q.city).trim() : '';
  const state = q.state !== undefined && q.state !== null ? String(q.state).trim().toUpperCase() : '';

  return {
    page,
    perPage,
    search: search.length > 0 ? search : null,
    phoneDigits: phoneRaw.length > 0 ? phoneRaw.replace(/\D/g, '') : null,
    industry: industry.length > 0 ? industry : null,
    city: city.length > 0 ? city : null,
    state: state.length > 0 ? state : null,
    lifecycleStates,
    sort,
    order: orderRaw,
  };
}

/**
 * Paginated business list with optional filters. Returns rows newest/ordered
 * first plus the total for pagination.
 */
export async function listBusinesses(q: ListBusinessesQuery): Promise<BusinessListResponse> {
  const parsed = parseListQuery(q);
  if ('error' in parsed) throw new Error(parsed.error);

  const conditions = [];
  if (parsed.search) conditions.push(ilike(businesses.business_name, `%${escapeLike(parsed.search)}%`));
  if (parsed.phoneDigits && parsed.phoneDigits.length > 0) {
    // Compare digit-stripped stored phone to the digit-stripped query.
    conditions.push(sql`regexp_replace(${businesses.phone}, '[^0-9]', '', 'g') LIKE ${'%' + parsed.phoneDigits + '%'}`);
  }
  if (parsed.industry) conditions.push(eq(sql`lower(${businesses.industry})`, parsed.industry));
  if (parsed.city) conditions.push(ilike(businesses.city, parsed.city));
  if (parsed.state) conditions.push(eq(sql`upper(${businesses.state})`, parsed.state));
  if (parsed.lifecycleStates.length === 1) {
    conditions.push(eq(businesses.lifecycle_state, parsed.lifecycleStates[0]!));
  } else if (parsed.lifecycleStates.length > 1) {
    conditions.push(inArray(businesses.lifecycle_state, parsed.lifecycleStates));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const orderCol = SORT_COLUMNS[parsed.sort];
  const orderBy = parsed.order === 'asc' ? asc(orderCol) : desc(orderCol);

  const [countRows, rows] = await Promise.all([
    db.select({ n: count() }).from(businesses).where(where),
    db
      .select({
        id: businesses.id,
        businessName: businesses.business_name,
        industry: businesses.industry,
        city: businesses.city,
        state: businesses.state,
        phone: businesses.phone,
        websiteUrl: businesses.website_url,
        lifecycleState: businesses.lifecycle_state,
        rating: businesses.rating,
        reviewCount: businesses.review_count,
        source: businesses.source,
        createdAt: businesses.created_at,
      })
      .from(businesses)
      .where(where)
      .orderBy(orderBy, desc(businesses.created_at))
      .limit(parsed.perPage)
      .offset((parsed.page - 1) * parsed.perPage),
  ]);

  const total = countRows[0]?.n ?? 0;
  const items: BusinessListItem[] = rows.map((r) => ({
    id: r.id,
    businessName: r.businessName,
    industry: r.industry,
    city: r.city,
    state: r.state,
    phone: r.phone,
    websiteUrl: r.websiteUrl,
    lifecycleState: r.lifecycleState,
    rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
    reviewCount: r.reviewCount,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }));

  return {
    businesses: items,
    page: parsed.page,
    perPage: parsed.perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.perPage)),
  };
}

/** Full detail for one business; null when the id does not exist. */
export async function getBusinessDetail(businessId: string): Promise<BusinessDetailResponse | null> {
  const [biz] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!biz) return null;

  const [scoreRows, siteRows, demoRows, rejectionRows, historyRows, auditRows] = await Promise.all([
    db
      .select()
      .from(leadScores)
      .where(eq(leadScores.business_id, businessId))
      .orderBy(desc(leadScores.created_at))
      .limit(1),
    db
      .select({
        url: websites.url,
        status: websites.status,
        analysisId: websiteAnalyses.id,
        score: websiteAnalyses.website_quality_score,
        classification: websiteAnalyses.classification,
        analyzedAt: websiteAnalyses.analyzed_at,
      })
      .from(websites)
      .leftJoin(websiteAnalyses, eq(websiteAnalyses.website_id, websites.id))
      .where(eq(websites.business_id, businessId))
      .orderBy(desc(websites.created_at))
      .limit(10),
    db
      .select()
      .from(demos)
      .where(eq(demos.business_id, businessId))
      .orderBy(desc(demos.created_at))
      .limit(5),
    db
      .select()
      .from(rejections)
      .where(eq(rejections.business_id, businessId))
      .orderBy(desc(rejections.created_at))
      .limit(20),
    db
      .select()
      .from(leadStateHistory)
      .where(eq(leadStateHistory.business_id, businessId))
      .orderBy(desc(leadStateHistory.created_at))
      .limit(25),
    db
      .select({
        action: auditLogs.action,
        actorType: auditLogs.actor_type,
        createdAt: auditLogs.created_at,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_type, 'business'), eq(auditLogs.entity_id, businessId)))
      .orderBy(desc(auditLogs.created_at))
      .limit(10),
  ]);

  const latest = scoreRows[0];
  const current = biz.lifecycle_state as LeadState;

  return {
    id: biz.id,
    businessName: biz.business_name,
    industry: biz.industry,
    address: biz.address,
    city: biz.city,
    state: biz.state,
    zip: biz.zip,
    phone: biz.phone,
    email: biz.email,
    websiteUrl: biz.website_url,
    source: biz.source,
    sourceUrl: biz.source_url,
    rating: biz.rating === null || biz.rating === undefined ? null : Number(biz.rating),
    reviewCount: biz.review_count,
    businessStatus: biz.business_status,
    decisionMakerName: biz.decision_maker_name,
    decisionMakerRole: biz.decision_maker_role,
    contactabilityScore: biz.contactability_score,
    lifecycleState: current,
    legalTransitions: [...legalTargets(current)],
    latestScore: latest
      ? {
          websiteQualityScore: latest.website_quality_score,
          businessOpportunityScore: latest.business_opportunity_score,
          marketFitScore: latest.market_fit_score === null || latest.market_fit_score === undefined ? null : Number(latest.market_fit_score),
          leadPriorityScore: latest.lead_priority_score === null || latest.lead_priority_score === undefined ? null : Number(latest.lead_priority_score),
          classification: latest.classification,
          createdAt: latest.created_at.toISOString(),
        }
      : null,
    websiteAnalyses: siteRows.map((r) => ({
      url: r.url,
      status: r.status,
      score: r.score,
      classification: r.analysisId ? String(r.classification) : 'NOT_ANALYZED',
      analyzedAt: r.analyzedAt ? r.analyzedAt.toISOString() : null,
    })),
    demos: demoRows.map((d) => ({
      id: d.id,
      status: d.status,
      demoUrl: d.demo_url,
      version: d.version,
      createdAt: d.created_at.toISOString(),
    })),
    rejections: rejectionRows.map((r) => ({
      reason: r.reason,
      detail: (r.detail ?? null) as Record<string, unknown> | null,
      createdAt: r.created_at.toISOString(),
    })),
    history: historyRows.map((h) => ({
      fromState: h.from_state,
      toState: h.to_state,
      note: h.note,
      createdAt: h.created_at.toISOString(),
    })),
    recentAudit: auditRows.map((a) => ({
      action: a.action,
      actorType: a.actorType,
      createdAt: a.createdAt.toISOString(),
    })),
    createdAt: biz.created_at.toISOString(),
    updatedAt: biz.updated_at.toISOString(),
  };
}

/** Escape LIKE wildcards in a user search string (ilike pattern). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Re-exported for a potential later created-after filter (kept to preserve the
// drizzle range helpers in one place should the console need them).
export { gte, lte, or };
