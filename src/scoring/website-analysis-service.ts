/**
 * WEBSITE ANALYSIS SERVICE — the main entry point of the website analysis
 * engine: fetch a business's website for real, run the EXISTING scoring math
 * (analyzeWebsite), persist the outcome, and surface owner-visible exceptions
 * on failure. This file contains no scoring logic of its own — it only fetches,
 * persists, and audits.
 *
 * Flow (analyzeBusinessWebsite):
 *  1. Recency short-circuit: an existing website_analyses row that is fresh
 *     enough and forceReanalyze=false → return the stored result untouched
 *     (re-analysis is opt-in).
 *  2. resolveWebsite: no website_url → WEBSITE_NOT_FOUND failure + a LOW
 *     `website_missing` exception (informational: a business without a website
 *     is still a perfectly good lead) and NO invented score.
 *  3. Fetch. ANY fetch failure → no invented score: write the failure into
 *     websites.status + a failed-analysis marker in website_analyses, create a
 *     MEDIUM `website_analysis_failed` exception, audit it, and return
 *     { websiteQualityScore: null, failure }.
 *  4. Success → analyzeWebsite(input, { weights, evaluator }) (the existing,
 *     unchanged scoring engine), persist website row + website_analyses row +
 *     audit inside ONE transaction, and return the full structured result.
 *
 * Deterministic fetch + reused scoring: the fetcher is plain TS (no vendor, no
 * AI), exactly like the in-repo QA pipeline — deliberately NOT an integration
 * registry module.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  businesses,
  websites,
  websiteAnalyses,
  exceptions,
  auditLogs,
  type CategoryScores,
} from '../db/schema.js';
import type { WebsiteInput } from './website-input.js';
import type { WebsiteQualityResult } from './website-quality.js';
import { analyzeWebsite } from './website-quality.js';
import { DEFAULT_EVALUATOR, type AiSubjectiveEvaluator } from './subjective.js';
import {
  getActiveScoringVersion,
  getWebsiteQualityWeights,
  getAiEvaluatorConfig,
} from './config.js';
import { fetchWebsite, type FetchOptions } from './website-fetch.js';
import { ScoringError } from './types.js';

/** Recency window fallback (real value comes from system_settings). */
const DEFAULT_RECENT_MS = 24 * 60 * 60 * 1000; // 24h

export interface AnalyzeWebsiteOptions {
  /** Force a fresh fetch + analysis (ignores the recency short-circuit). */
  forceReanalyze?: boolean;
  /** AI subjective evaluator — injected for tests/AI-enabled runs. Defaults to
   *  the deterministic fallback (AI evaluator is requires-configuration). */
  evaluator?: AiSubjectiveEvaluator;
  /** Fetch knobs (timeouts, page budget) — defaults live in the fetcher. */
  fetchOptions?: FetchOptions;
}

export interface AnalyzeWebsiteFailure {
  reason: string;
  message: string;
  httpStatus?: number | null;
}

/** The structured result of analyzing a business's website. */
export interface AnalyzeWebsiteResult {
  analysisId: string | null;
  websiteId: string | null;
  version: string | null;
  website: {
    id: string;
    url: string;
    status: string;
    httpStatus: number | null;
    domain: string | null;
  };
  websiteQualityScore: number | null;
  classification: string | null;
  categoryScores: CategoryScores | null;
  categoryVerdicts: WebsiteQualityResult['categoryVerdicts'] | null;
  testResults: WebsiteQualityResult['testResults'] | null;
  evidence: {
    /** The engine's own evidence payload. */
    [key: string]: unknown;
  } | null;
  criticalFailures: unknown[] | null;
  failure: AnalyzeWebsiteFailure | null;
  /** True when this result came from a fresh fetch + analysis (false = the
   *  recency short-circuit served a stored result). */
  fresh: boolean;
}

interface ResolveOutcome {
  hasWebsite: boolean;
  websiteInput?: WebsiteInput;
  failure?: AnalyzeWebsiteFailure;
}

/** The gate: determine whether a website exists for this business. */
export async function resolveWebsite(businessId: string): Promise<ResolveOutcome> {
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!business) {
    throw new ScoringError('BUSINESS_NOT_FOUND', `Business ${businessId} not found`);
  }
  const rawUrl = business.website_url?.trim();
  if (!rawUrl) {
    return { hasWebsite: false };
  }
  const fetchResult = await fetchWebsite(rawUrl);
  if (!fetchResult.ok || !fetchResult.websiteInput) {
    const f = fetchResult.failure ?? {
      reason: 'INTERNAL_ERROR',
      message: 'website fetch failed without a recorded reason',
    };
    return {
      hasWebsite: true,
      failure: {
        reason: f.reason,
        message: f.message,
        httpStatus: f.httpStatus ?? null,
      },
    };
  }
  return { hasWebsite: true, websiteInput: fetchResult.websiteInput };
}

/**
 * Analyze (or re-analyze) a business's website. Idempotent within a recency
 * window; re-analysis is opt-in via forceReanalyze. Never throws for fetch or
 * analysis outcomes — failures are returned as structured results with an
 * owner-visible exception.
 */
export async function analyzeBusinessWebsite(
  businessId: string,
  opts: AnalyzeWebsiteOptions = {},
): Promise<AnalyzeWebsiteResult> {
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!business) {
    throw new ScoringError('BUSINESS_NOT_FOUND', `Business ${businessId} not found`);
  }

  // --- 1. Recency short-circuit (idempotent; re-analysis is opt-in). ---
  const recentMs = await recentWindowMs();
  if (!opts.forceReanalyze) {
    const stale = await latestAnalysis(businessId);
    if (stale && stale.analyzed_at && Date.now() - stale.analyzed_at.getTime() <= recentMs) {
      return toResult(stale, business, false);
    }
  }

  // --- 2. Resolve the website (fetch for real). --------------------------
  const resolved = await resolveWebsite(businessId);
  if (!resolved.hasWebsite) {
    // No URL: NO_WEBSITE path — a WEBSITE_NOT_FOUND failure + a low-priority
    // informational exception. No score is invented. A business without a
    // website is a perfectly good lead — this is not a block.
    await db.transaction(async (tx) => {
      await tx.insert(exceptions).values({
        entity_type: 'business',
        entity_id: businessId,
        priority: 'LOW',
        category: 'website_missing',
        status: 'OPEN',
        message: 'no website URL recorded for business',
        details: { reason: 'WEBSITE_NOT_FOUND' },
      });
      await tx.insert(auditLogs).values({
        actor_type: 'SYSTEM',
        actor_id: null,
        action: 'WEBSITE_ANALYSIS_FAILED',
        entity_type: 'business',
        entity_id: businessId,
        before: null,
        after: { reason: 'WEBSITE_NOT_FOUND', message: 'no website URL recorded for business' },
        source: 'website-analysis',
        metadata: { reason: 'WEBSITE_NOT_FOUND', website_url: null },
      });
    });
    return noWebsiteResult(businessId);
  }

  // --- 3. Fetch failure → no invented score. -----------------------------
  if (resolved.failure) {
    return persistFailure(businessId, business.website_url ?? '', resolved.failure);
  }

  // --- 4. Success → run the EXISTING scoring math + persist. -------------
  const input = resolved.websiteInput!;
  const [wsqVersion, wsqWeights, aiCfg] = await Promise.all([
    getActiveScoringVersion('WEBSITE_QUALITY'),
    getWebsiteQualityWeights(),
    getAiEvaluatorConfig(),
  ]);
  const evaluator: AiSubjectiveEvaluator = opts.evaluator ?? DEFAULT_EVALUATOR;
  const analysis = analyzeWebsite(input, { weights: wsqWeights, evaluator });

  const persisted = await persistSuccess(businessId, input, analysis, wsqVersion.id, {
    evaluatorName: evaluator.name,
    aiConfigured: aiCfg.configured,
    weights: wsqWeights.weights,
    promptRef: aiCfg.promptRef ?? null,
  });

  // Analysis succeeded → any prior open failure/missing exception for this
  // business is stale; resolve it.
  await resolvePriorExceptions(businessId);

  return {
    analysisId: persisted.analysisId,
    websiteId: persisted.websiteId,
    version: wsqVersion.id,
    website: persisted.website,
    websiteQualityScore: analysis.websiteQualityScore,
    classification: analysis.classification,
    categoryScores: analysis.categoryScores,
    categoryVerdicts: analysis.categoryVerdicts,
    testResults: analysis.testResults,
    evidence: {
      ...analysis.evidence,
      weights: wsqWeights.weights,
      ai_evaluator: {
        configured: aiCfg.configured,
        provider: aiCfg.provider ?? null,
        model: aiCfg.model ?? null,
        promptRef: aiCfg.promptRef ?? null,
      },
    },
    criticalFailures: analysis.criticalFailures,
    failure: null,
    fresh: true,
  };
}

/** Force a fresh re-analysis (keeps history — a new website_analyses row is
 *  inserted each time; the previous row is never deleted). */
export function reanalyzeBusinessWebsite(
  businessId: string,
  opts: Omit<AnalyzeWebsiteOptions, 'forceReanalyze'> = {},
): Promise<AnalyzeWebsiteResult> {
  return analyzeBusinessWebsite(businessId, { ...opts, forceReanalyze: true });
}

/* --- persistence ------------------------------------------------------------ */

interface PersistedSuccess {
  analysisId: string;
  websiteId: string;
  website: AnalyzeWebsiteResult['website'];
}

interface EvidenceCtx {
  evaluatorName: string;
  aiConfigured: boolean;
  weights: Record<string, number>;
  promptRef: string | null;
}

async function persistSuccess(
  businessId: string,
  input: WebsiteInput,
  analysis: WebsiteQualityResult,
  versionId: string,
  evidenceCtx: EvidenceCtx,
): Promise<PersistedSuccess> {
  return db.transaction(async (tx) => {
    let [site] = await tx
      .select()
      .from(websites)
      .where(eq(websites.business_id, businessId))
      .limit(1);
    const observedDomain = toDomain(input.url);
    if (!site) {
      const [created] = await tx
        .insert(websites)
        .values({
          business_id: businessId,
          url: input.url,
          status: 'ANALYZED',
          http_status: input.pages[0]?.httpStatus ?? null,
          domain: observedDomain,
          discovered_at: new Date(),
        })
        .returning();
      site = created!;
    } else {
      await tx
        .update(websites)
        .set({
          url: input.url,
          status: 'ANALYZED',
          http_status: input.pages[0]?.httpStatus ?? null,
          domain: observedDomain,
        })
        .where(eq(websites.id, site.id));
    }
    const websiteId = site.id;

    const [analysisRow] = await tx
      .insert(websiteAnalyses)
      .values({
        website_id: websiteId,
        website_quality_score: analysis.websiteQualityScore,
        classification: analysis.classification,
        category_scores: analysis.categoryScores,
        test_results: { outcomes: analysis.testResults },
        evidence: {
          ...analysis.evidence,
          weights: evidenceCtx.weights,
          ai_evaluator: {
            configured: evidenceCtx.aiConfigured,
            provider: null,
            model: null,
            promptRef: evidenceCtx.promptRef,
          },
        },
        critical_failures: analysis.criticalFailures,
        analysis_version: versionId,
        analyzed_at: new Date(),
      })
      .returning({ id: websiteAnalyses.id });
    const analysisId = analysisRow!.id;

    await tx.insert(auditLogs).values({
      actor_type: 'SYSTEM',
      actor_id: null,
      action: 'WEBSITE_ANALYZED',
      entity_type: 'website',
      entity_id: websiteId,
      before: null,
      after: null,
      source: 'website-analysis',
      metadata: {
        analysis_id: analysisId,
        website_quality_score: analysis.websiteQualityScore,
        classification: analysis.classification,
        analysis_version: versionId,
        weights: evidenceCtx.weights,
      },
    });

    return {
      analysisId,
      websiteId,
      website: {
        id: websiteId,
        url: site.url,
        status: 'ANALYZED',
        httpStatus: input.pages[0]?.httpStatus ?? null,
        domain: observedDomain,
      },
    };
  });
}

async function persistFailure(
  businessId: string,
  rawUrl: string,
  failure: AnalyzeWebsiteFailure,
): Promise<AnalyzeWebsiteResult> {
  // The active WSQ version may be absent (unseeded DB) — a failure result does
  // not depend on it; the marker row simply records null version.
  const wsqVersion = await getActiveScoringVersion('WEBSITE_QUALITY').catch(() => null);
  return db.transaction(async (tx) => {
    let [site] = await tx
      .select()
      .from(websites)
      .where(eq(websites.business_id, businessId))
      .limit(1);
    if (!site) {
      const [created] = await tx
        .insert(websites)
        .values({
          business_id: businessId,
          url: rawUrl,
          status: 'CRAWL_FAILED',
          http_status: failure.httpStatus ?? null,
          domain: toDomain(rawUrl),
          discovered_at: new Date(),
        })
        .returning();
      site = created!;
    } else {
      await tx
        .update(websites)
        .set({ status: 'CRAWL_FAILED', http_status: failure.httpStatus ?? null })
        .where(eq(websites.id, site.id));
    }
    const websiteId = site.id;

    // Failure marker: same table, no score (never an invented value).
    const [marker] = await tx
      .insert(websiteAnalyses)
      .values({
        website_id: websiteId,
        website_quality_score: null,
        classification: 'NO_WEBSITE',
        category_scores: null,
        test_results: null,
        evidence: {
          failure: { reason: failure.reason, message: failure.message, httpStatus: failure.httpStatus ?? null },
        },
        critical_failures: null,
        analysis_version: wsqVersion?.id ?? null,
        analyzed_at: new Date(),
      })
      .returning({ id: websiteAnalyses.id });

    await tx.insert(exceptions).values({
      entity_type: 'business',
      entity_id: businessId,
      priority: 'MEDIUM',
      category: 'website_analysis_failed',
      status: 'OPEN',
      message: failure.message,
      details: { reason: failure.reason, httpStatus: failure.httpStatus ?? null, website_url: rawUrl },
    });

    await tx.insert(auditLogs).values({
      actor_type: 'SYSTEM',
      actor_id: null,
      action: 'WEBSITE_ANALYSIS_FAILED',
      entity_type: 'website',
      entity_id: websiteId,
      before: null,
      after: { reason: failure.reason, message: failure.message, httpStatus: failure.httpStatus ?? null },
      source: 'website-analysis',
      metadata: { analysis_id: marker!.id, reason: failure.reason, http_status: failure.httpStatus ?? null },
    });

    return {
      analysisId: marker!.id,
      websiteId,
      version: wsqVersion?.id ?? null,
      website: {
        id: websiteId,
        url: site.url,
        status: 'CRAWL_FAILED',
        httpStatus: failure.httpStatus ?? null,
        domain: toDomain(rawUrl),
      },
      websiteQualityScore: null,
      classification: null,
      categoryScores: null,
      categoryVerdicts: null,
      testResults: null,
      evidence: null,
      criticalFailures: null,
      failure,
      fresh: true,
    };
  });
}

/** Resolve open website-related exceptions for a business (analysis just
 *  succeeded — the stale failure/missing exception is gone). */
async function resolvePriorExceptions(businessId: string): Promise<void> {
  await db
    .update(exceptions)
    .set({ status: 'RESOLVED', resolved_at: new Date() })
    .where(
      and(
        eq(exceptions.entity_type, 'business'),
        eq(exceptions.entity_id, businessId),
        eq(exceptions.status, 'OPEN'),
        inArray(exceptions.category, ['website_analysis_failed', 'website_missing']),
      ),
    );
}

/* --- helpers ---------------------------------------------------------------- */

type StoredAnalysis = typeof websiteAnalyses.$inferSelect & {
  url: string | null;
  httpStatus: number | null;
};

/** Latest website_analyses row for a business (via its websites rows). */
async function latestAnalysis(businessId: string): Promise<StoredAnalysis | null> {
  const [site] = await db
    .select()
    .from(websites)
    .where(eq(websites.business_id, businessId))
    .limit(1);
  if (!site) return null;
  const [row] = await db
    .select()
    .from(websiteAnalyses)
    .where(eq(websiteAnalyses.website_id, site.id))
    .orderBy(desc(websiteAnalyses.analyzed_at))
    .limit(1);
  if (!row) return null;
  return { ...row, url: site.url, httpStatus: site.http_status };
}

/** Rebuild the structured result from a stored analysis (recency short-circuit). */
function toResult(
  row: StoredAnalysis,
  business: { website_url: string | null },
  fresh: boolean,
): AnalyzeWebsiteResult {
  return {
    analysisId: row.id,
    websiteId: row.website_id,
    version: row.analysis_version,
    website: {
      id: row.website_id,
      url: business.website_url ?? row.url ?? '',
      status: 'ANALYZED',
      httpStatus: row.httpStatus ?? null,
      domain: null,
    },
    websiteQualityScore: row.website_quality_score,
    classification: row.classification,
    categoryScores: row.category_scores,
    // Verdicts aren't stored separately; stored result exposes what was stored.
    categoryVerdicts: null,
    testResults: ((row.test_results as { outcomes?: unknown[] } | null)?.outcomes as WebsiteQualityResult['testResults']) ?? null,
    evidence: {
      ...(row.evidence ?? {}),
      note: 'served from stored analysis (recency short-circuit)',
    },
    criticalFailures: row.critical_failures,
    failure: null,
    fresh,
  };
}

function noWebsiteResult(businessId: string): AnalyzeWebsiteResult {
  return {
    analysisId: null,
    websiteId: null,
    version: null,
    website: {
      id: '',
      url: '',
      status: 'NO_WEBSITE',
      httpStatus: null,
      domain: null,
    },
    websiteQualityScore: null,
    classification: null,
    categoryScores: null,
    categoryVerdicts: null,
    testResults: null,
    evidence: null,
    criticalFailures: null,
    failure: { reason: 'WEBSITE_NOT_FOUND', message: 'no website URL recorded for business', httpStatus: null },
    fresh: true,
  };
}

/** Recency window from system_settings `analysis.website_recent_ms`
 *  (read via the raw SettingsService — the accessor surface has no number
 *  getter; this key is seeded with a default). */
async function recentWindowMs(): Promise<number> {
  try {
    const { settingsService } = await import('../config/singleton.js');
    const row = await settingsService.get('analysis.website_recent_ms');
    const value = row?.value;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_RECENT_MS;
}

function toDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}