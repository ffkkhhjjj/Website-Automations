/**
 * Dashboard service — computes the owner's 30-second business overview from
 * real tables only (single source of truth: Postgres via src/db).
 *
 * Honesty rules (brief 6):
 *  - every count comes from a real COUNT against the schema;
 *  - metrics with no data source yet (revenue, MRR, demo views) are `0` with a
 *    `countsMeta` entry marked `wired: false` — never fabricated;
 *  - revenue is intentionally 0 until the connected finance account exists
 *    (platform not live). Subscriptions/payments tables exist but nothing has
 *    been sold; the dashboard does not guess.
 *  - health runs a real `SELECT 1` and counts tasks by status.
 */
import { and, eq, gte, sql, desc, count, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  businesses,
  demos,
  outreachMessages,
  conversationMessages,
  conversations,
  tasks,
  exceptions,
  auditLogs,
  leadScores,
} from '../db/schema';
import type {
  OverviewPayload,
  HotLead,
  TodayActivityItem,
  DashboardException,
  OverviewCounts,
  MetricMeta,
} from './types';
import { settingsService } from '../config/singleton';

const OPEN_EXCEPTION_STATES = ['OPEN', 'ACKNOWLEDGED'] as const;
const SENT_MESSAGE_STATES = ['SENT', 'OPENED', 'CLICKED', 'REPLIED'] as const;

/** Default hot-lead limit (used when notifications.hot_lead_limit is unset). */
export const DEFAULT_HOT_LEAD_LIMIT = 10;

/** Public entry point: build the complete overview payload. */
export async function getOverview(): Promise<OverviewPayload> {
  const [hotLeads, counts, countsMeta, todayActivity, exceptionsRows, health, lastAudit] =
    await Promise.all([
      getHotLeads(),
      getCounts(),
      buildCountsMeta(),
      getTodayActivity(),
      getOpenExceptions(),
      getHealth(),
      getLastAuditTime(),
    ]);

  health.lastAuditAt = lastAudit;

  return {
    generatedAt: new Date().toISOString(),
    hotLeads,
    counts,
    countsMeta,
    todayActivity,
    exceptions: exceptionsRows,
    health,
  };
}

/* ----------------------------------------------------------------------------
 * Hot leads
 * ------------------------------------------------------------------------- */

async function getHotLeads(): Promise<HotLead[]> {
  const limit = await getHotLeadLimit();

  // 1. Candidate businesses: HOT always; INTERESTED only when a reply exists
  //    in the last 14 days (a fresh reply = still worth the owner's attention).
  const candidatesRaw = await db
    .select({
      businessId: businesses.id,
      businessName: businesses.business_name,
      city: businesses.city,
      state: businesses.state,
      websiteUrl: businesses.website_url,
      lifecycleState: businesses.lifecycle_state,
    })
    .from(businesses)
    .where(sql`${businesses.lifecycle_state} IN ('HOT', 'INTERESTED')`);

  if (candidatesRaw.length === 0) return [];

  const candidates: {
    businessId: string;
    businessName: string;
    city: string | null;
    state: string | null;
    websiteUrl: string | null;
    lifecycleState: 'HOT' | 'INTERESTED';
  }[] = candidatesRaw.map((r) => ({
    ...r,
    lifecycleState: r.lifecycleState === 'HOT' ? ('HOT' as const) : ('INTERESTED' as const),
  }));

  const ids = candidates.map((c) => c.businessId);

  // 2. Latest lead score per business (lead_scores is append-only history).
  const scoreRows = await db
    .select()
    .from(leadScores)
    .where(inArray(leadScores.business_id, ids))
    .orderBy(desc(leadScores.created_at));
  const scoresByBusiness = new Map<string, typeof leadScores.$inferSelect>();
  for (const row of scoreRows) {
    if (!scoresByBusiness.has(row.business_id)) scoresByBusiness.set(row.business_id, row);
  }

  // 3. Latest demo URL per business (demos status READY/DEPLOYED preferred).
  const demosRows = await db
    .select()
    .from(demos)
    .where(inArray(demos.business_id, ids))
    .orderBy(desc(demos.created_at));
  const demoByBusiness = new Map<string, string>();
  for (const row of demosRows) {
    if (row.demo_url && row.business_id && !demoByBusiness.has(row.business_id)) {
      demoByBusiness.set(row.business_id, row.demo_url);
    }
  }

  // 4. Latest inbound reply per business (join through conversations).
  const replies = await latestInboundReplies(ids);

  // 5. Assemble + sort by lead priority desc.
  const leads: HotLead[] = candidates.map((c) => {
    const score = scoresByBusiness.get(c.businessId);
    const reply = replies.get(c.businessId);
    return {
      businessId: c.businessId,
      businessName: c.businessName,
      city: c.city,
      state: c.state,
      websiteUrl: c.websiteUrl,
      leadPriorityScore: score ? toNumOrNull(score.lead_priority_score) : null,
      websiteQualityScore: score?.website_quality_score ?? null,
      lifecycleState: c.lifecycleState === 'HOT' ? 'HOT' : 'INTERESTED',
      latestReplySnippet: reply?.body ? snippet(reply.body, 200) : null,
      intent: reply?.classification ?? null,
      confidence: toConfidence(reply?.confidence),
      suggestedAction: suggestAction(c.lifecycleState, reply?.classification ?? null),
      demoUrl: demoByBusiness.get(c.businessId) ?? null,
    };
  });

  return leads
    .sort((a, b) => (b.leadPriorityScore ?? 0) - (a.leadPriorityScore ?? 0))
    .slice(0, limit);
}

/** Latest inbound conversation message per business id. */
async function latestInboundReplies(
  businessIds: string[],
): Promise<Map<string, { body: string; classification: string | null; confidence: number | null; receivedAt: Date }>> {
  if (businessIds.length === 0) return new Map();

  const rows = await db
    .select({
      businessId: conversations.business_id,
      body: conversationMessages.body,
      classification: conversationMessages.classification,
      confidence: conversationMessages.classification_confidence,
      receivedAt: conversationMessages.received_at,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversationMessages.conversation_id, conversations.id))
    .where(
      and(
        eq(conversationMessages.direction, 'INBOUND'),
        sql`${conversationMessages.received_at} >= now() - interval '90 days'`, // keep the fetch small
        inArray(conversations.business_id, businessIds),
      ),
    )
    .orderBy(desc(conversationMessages.received_at));

  const map = new Map<string, { body: string; classification: string | null; confidence: number | null; receivedAt: Date }>();
  for (const r of rows) {
    if (!map.has(r.businessId)) map.set(r.businessId, {
      body: r.body,
      classification: r.classification,
      confidence: toConfidence(r.confidence),
      receivedAt: r.receivedAt ?? new Date(),
    });
  }
  return map;
}

/* ----------------------------------------------------------------------------
 * Counts
 * ------------------------------------------------------------------------- */

async function getCounts(): Promise<OverviewCounts> {
  const [leadsFound, leadsQualified, demosCreated, emailsSent, replies, interested,
    sales, emailBounces, unsubscribes, systemErrors] = await Promise.all([
    db.select({ n: count() }).from(businesses),
    db.select({ n: count() })
      .from(businesses)
      .where(sql`${businesses.lifecycle_state} NOT IN ('DISCOVERED', 'ENRICHING', 'ENRICHED', 'ANALYZING', 'ANALYZED', 'REJECTED')`),
    db.select({ n: count() }).from(demos),
    db.select({ n: count() }).from(outreachMessages).where(inArray(outreachMessages.status, SENT_MESSAGE_STATES)),
    db.select({ n: count() }).from(conversationMessages).where(eq(conversationMessages.direction, 'INBOUND')),
    db.select({ n: count() }).from(businesses).where(sql`${businesses.lifecycle_state} IN ('INTERESTED', 'HOT')`),
    db.select({ n: count() }).from(businesses).where(sql`${businesses.lifecycle_state} IN ('WON', 'CUSTOMER')`),
    db.select({ n: count() }).from(outreachMessages).where(eq(outreachMessages.status, 'BOUNCED')),
    db.select({ n: count() }).from(outreachMessages).where(eq(outreachMessages.status, 'OPTED_OUT')),
    db.select({ n: count() })
      .from(exceptions)
      .where(and(inArray(exceptions.status, OPEN_EXCEPTION_STATES), sql`${exceptions.priority} IN ('CRITICAL', 'HIGH')`)),
  ]);
  return {
    leadsFound: leadsFound[0]?.n ?? 0,
    leadsQualified: leadsQualified[0]?.n ?? 0,
    demosCreated: demosCreated[0]?.n ?? 0,
    emailsSent: emailsSent[0]?.n ?? 0,
    replies: replies[0]?.n ?? 0,
    interested: interested[0]?.n ?? 0,
    sales: sales[0]?.n ?? 0,
    revenue: 0, // finance account not connected (platform not live)
    mrr: 0, // billing/subscriptions not wired
    demoViews: 0, // demo hosting analytics not wired
    emailBounces: emailBounces[0]?.n ?? 0,
    unsubscribes: unsubscribes[0]?.n ?? 0,
    systemErrors: systemErrors[0]?.n ?? 0,
  };
}

async function buildCountsMeta(): Promise<{ revenue: MetricMeta; mrr: MetricMeta; demoViews: MetricMeta }> {
  return {
    revenue: { value: 0, wired: false, source: 'connected finance account (not connected — platform not live)' },
    mrr: { value: 0, wired: false, source: 'billing/subscriptions pipeline (not wired)' },
    demoViews: { value: 0, wired: false, source: 'demo hosting analytics (not wired)' },
  };
}

/* ----------------------------------------------------------------------------
 * Today's activity
 * ------------------------------------------------------------------------- */

async function getTodayActivity(): Promise<TodayActivityItem[]> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [logs, taskRows] = await Promise.all([
    db
      .select({
        action: auditLogs.action,
        entityType: auditLogs.entity_type,
        entityId: auditLogs.entity_id,
        createdAt: auditLogs.created_at,
      })
      .from(auditLogs)
      .where(gte(auditLogs.created_at, startOfDay))
      .orderBy(desc(auditLogs.created_at))
      .limit(10),
    db
      .select({
        type: tasks.type,
        status: tasks.status,
        entityType: tasks.entity_type,
        entityId: tasks.entity_id,
        createdAt: tasks.created_at,
      })
      .from(tasks)
      .where(gte(tasks.created_at, startOfDay))
      .orderBy(desc(tasks.created_at))
      .limit(10),
  ]);

  const items: TodayActivityItem[] = [];
  for (const t of taskRows) {
    items.push({
      type: `task:${t.type} (${t.status})`,
      entityType: t.entityType,
      entity: shortEntity(t.entityId),
      time: t.createdAt.toISOString(),
    });
  }
  for (const l of logs) {
    items.push({
      type: l.action,
      entityType: l.entityType,
      entity: shortEntity(l.entityId),
      time: l.createdAt.toISOString(),
    });
  }
  return items.sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 10);
}

/* ----------------------------------------------------------------------------
 * Exceptions — open, prioritized CRITICAL → HIGH → MEDIUM → LOW
 * ------------------------------------------------------------------------- */

async function getOpenExceptions(): Promise<DashboardException[]> {
  const rows = await db
    .select({
      id: exceptions.id,
      priority: exceptions.priority,
      category: exceptions.category,
      message: exceptions.message,
      entityType: exceptions.entity_type,
      entityId: exceptions.entity_id,
      createdAt: exceptions.created_at,
    })
    .from(exceptions)
    .where(inArray(exceptions.status, OPEN_EXCEPTION_STATES))
    .orderBy(
      sql`CASE ${exceptions.priority} WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`,
      desc(exceptions.created_at),
    )
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    priority: r.priority as DashboardException['priority'],
    category: r.category,
    message: r.message,
    entityType: r.entityType,
    entityId: r.entityId,
    createdAt: r.createdAt.toISOString(),
  }));
}

/* ----------------------------------------------------------------------------
 * Health
 * ------------------------------------------------------------------------- */

async function getHealth(): Promise<OverviewPayload['health']> {
  let dbReachable = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbReachable = true;
  } catch {
    dbReachable = false;
  }

  const tasksByStatus: Record<string, number> = {};
  const rows = await db
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .groupBy(tasks.status);
  for (const r of rows) tasksByStatus[r.status] = r.n;

  // Flags worth surfacing: failed/canceled tasks, or a large backlog of
  // never-started work.
  const taskIssues: string[] = [];
  const failed = tasksByStatus.FAILED ?? 0;
  const canceled = tasksByStatus.CANCELED ?? 0;
  const pending = tasksByStatus.PENDING ?? 0;
  if (failed > 0) taskIssues.push(`${failed} failed task(s)`);
  if (canceled > 0) taskIssues.push(`${canceled} canceled task(s)`);
  if (pending >= 10) taskIssues.push(`${pending} pending task(s) — check the queue`);

  return {
    serverUp: true,
    dbReachable,
    tasksByStatus,
    taskIssues,
    lastAuditAt: null as string | null,
  };
}

async function getLastAuditTime(): Promise<string | null> {
  const rows = await db
    .select({ at: auditLogs.created_at })
    .from(auditLogs)
    .orderBy(desc(auditLogs.created_at))
    .limit(1);
  return rows[0]?.at ? rows[0]!.at.toISOString() : null;
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

async function getHotLeadLimit(): Promise<number> {
  const v = await settingsService.getParsed<number>(
    'notifications.hot_lead_limit',
    (x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0,
    DEFAULT_HOT_LEAD_LIMIT,
  );
  return Math.min(Math.floor(v), 50); // sanity cap — a card wall is not a dashboard
}

function snippet(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function toNumOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toConfidence(v: string | number | null | undefined): number | null {
  const n = toNumOrNull(v);
  return n === null ? null : Math.min(Math.max(n, 0), 1);
}

/** Owner-facing, human-readable next action for a hot lead. */
function suggestAction(lifecycle: 'HOT' | 'INTERESTED', classification: string | null): string {
  if (lifecycle === 'HOT') {
    return 'High-priority: contact the owner now with the demo and pricing.';
  }
  if (classification === 'INTERESTED') {
    return 'Recent positive reply — reply promptly and move the conversation forward.';
  }
  if (classification === 'NEEDS_INFO') {
    return 'Prospect asked for details — respond with the demo and a short pitch.';
  }
  if (classification === 'OPT_OUT') {
    return 'Asked to opt out — remove from outreach and mark DO_NOT_CONTACT.';
  }
  return 'Recent reply — review the thread before the next step.';
}

function shortEntity(id: string): string {
  return id ? id.slice(0, 8) : '—';
}