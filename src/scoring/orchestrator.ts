/**
 * SCORING ORCHESTRATOR — the only entry point that runs scoring end-to-end.
 *
 * `scoreBusiness(businessId, opts)`:
 *  - loads the business + its websites;
 *  - runs whichever engine pieces the business's stage needs (a business with
 *    no website gets WSQ=0 / NO_WEBSITE; a business with crawl data gets a full
 *    website quality analysis);
 *  - runs BOS + Lead Priority;
 *  - persists: one website_analyses row (per website analyzed), ONE lead_scores
 *    row (formula/weights snapshot + scoring_version FK), and audit entries
 *    (actions WEBSITE_ANALYZED / LEAD_SCORED, source 'scoring').
 *
 * The orchestrator NEVER touches the lifecycle state machine — scoring is
 * invoked FROM the pipeline; transitions stay the state machine's job.
 */
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  businesses,
  websites,
  websiteAnalyses,
  leadScores,
  auditLogs,
  type CategoryScores,
} from '../db/schema.js';
import { ScoringError } from './types.js';
import {
  getActiveScoringVersion,
  getWebsiteQualityWeights,
  getBusinessOpportunityWeights,
  getLeadPriorityWeights,
  getLeadClassificationThresholds,
  getTargetConfig,
  getAiEvaluatorConfig,
  type TargetConfig,
} from './config.js';
import { analyzeWebsite, scoreNoWebsite } from './website-quality.js';
import { scoreOpportunity, type OpportunityInput } from './business-opportunity.js';
import { scoreLeadPriority } from './lead-priority.js';
import type { WebsiteInput } from './website-input.js';
import { DEFAULT_EVALUATOR, type AiSubjectiveEvaluator } from './subjective.js';

export interface ScoreBusinessOptions {
  /** Observed crawl data for the business's website (when it has one). */
  websiteInput?: WebsiteInput | null;
  /** Business opportunity signals (defaults to the businesses row). */
  opportunityInput?: OpportunityInput | null;
  /** 0-100 market fit; defaults to the icp_fit category from this run. */
  marketFit?: number | null;
  /** AI subjective evaluator — injected for tests/AI-enabled runs. Defaults
   *  to the deterministic fallback (AI evaluator is requires-configuration). */
  evaluator?: AiSubjectiveEvaluator;
}

export interface ScoreBusinessResult {
  businessId: string;
  websiteAnalysisId: string | null;
  leadScoreId: string;
  websiteQualityScore: number | null;
  businessOpportunityScore: number;
  marketFitScore: number;
  leadPriorityScore: number;
  leadClassification: string;
  scoringVersionId: string;
}

export async function scoreBusiness(
  businessId: string,
  opts: ScoreBusinessOptions = {},
): Promise<ScoreBusinessResult> {
  // Resolve the active scoring version + config first (single snapshot for
  // the whole run; currently one version per score_type, all v1 = same id).
  const wsqVersion = await getActiveScoringVersion('WEBSITE_QUALITY');
  const bosVersion = await getActiveScoringVersion('BUSINESS_OPPORTUNITY');
  const lpVersion = await getActiveScoringVersion('LEAD_PRIORITY');
  const [wsqWeights, bosWeights, lpWeights, thresholds, target] = await Promise.all([
    getWebsiteQualityWeights(),
    getBusinessOpportunityWeights(),
    getLeadPriorityWeights(),
    getLeadClassificationThresholds(),
    getTargetConfig(),
  ]);

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!business) {
    throw new ScoringError('BUSINESS_NOT_FOUND', `Business ${businessId} not found`);
  }

  // --- 1. Website quality -------------------------------------------------
  let websiteId: string | null = null;
  let websiteQualityScore: number | null = null;
  let websiteClassification: string | null = null;
  let categoryScores: CategoryScores | null = null;
  let testResults: Record<string, unknown> | null = null;
  let analysisEvidence: Record<string, unknown> | null = null;
  let criticalFailures: unknown[] | null = null;

  const websiteInput = opts.websiteInput ?? null;
  const withSite = websiteInput !== null;
  if (withSite) {
    const siteInput: WebsiteInput = websiteInput;
    // Prefer an existing website row for this business; create one when the
    // crawl input arrived without one (observed URL is real evidence).
    let [site] = await db
      .select()
      .from(websites)
      .where(eq(websites.business_id, businessId))
      .limit(1);
    if (!site) {
      const now = new Date();
      const [created] = await db
        .insert(websites)
        .values({
          business_id: businessId,
          url: siteInput.url,
          status: 'DISCOVERED',
          domain: toDomain(siteInput.url),
          discovered_at: now,
        })
        .returning();
      site = created!;
    }
    websiteId = site.id;

    const aiCfg = await getAiEvaluatorConfig();
    // A real AI evaluator is NOT wired in this brief; the interface + env are
    // ready, and getAiEvaluatorConfig() documents the requires-configuration
    // state. The deterministic fallback keeps the pipeline fully functional.
    const evaluator: AiSubjectiveEvaluator = opts.evaluator ?? DEFAULT_EVALUATOR;

    const analysis = analyzeWebsite(siteInput, {
      weights: wsqWeights,
      evaluator,
    });
    websiteQualityScore = analysis.websiteQualityScore;
    websiteClassification = analysis.classification;
    categoryScores = analysis.categoryScores;
    testResults = { outcomes: analysis.testResults } as Record<string, unknown>;
    analysisEvidence = {
      evidence: analysis.evidence,
      weights: wsqWeights.weights,
      ai_evaluator: {
        configured: aiCfg.configured,
        provider: aiCfg.provider ?? null,
        model: aiCfg.model ?? null,
        promptRef: aiCfg.promptRef ?? null,
      },
    };
    criticalFailures = analysis.criticalFailures;
  } else if ((business.website_url ?? null) === null && opts.websiteInput === undefined) {
    // No website observed at all → WSQ 0, classification NO_WEBSITE.
    const noSite = scoreNoWebsite();
    websiteQualityScore = noSite.websiteQualityScore;
    websiteClassification = noSite.classification;
    categoryScores = noSite.categoryScores;
    testResults = null;
    analysisEvidence = noSite.evidence;
    criticalFailures = [];
  } else {
    // Website URL exists but no crawl data was provided — cannot fabricate.
    websiteQualityScore = null;
  }

  // --- 2. Business opportunity --------------------------------------------
  const opportunityInput: OpportunityInput = opts.opportunityInput ?? {
    industry: business.industry,
    state: business.state,
    business_status: business.business_status,
    has_nap: Boolean(business.address || business.phone),
    rating: toNum(business.rating),
    review_count: business.review_count,
    services: business.services ?? [],
    business_description: business.business_description ?? null,
    ability_signals: null,
    contactability_score: business.contactability_score,
    has_phone: Boolean(business.phone),
    has_email: Boolean(business.email),
    has_contact_route: Boolean(business.email || business.phone),
  };
  const opportunity = scoreOpportunity(opportunityInput, {
    weights: bosWeights,
    target,
  });
  const businessOpportunityScore = opportunity.businessOpportunityScore;

  // --- 3. Lead priority ---------------------------------------------------
  const marketFitScore =
    opts.marketFit ??
    (opportunity.categoryScores.icp_fit ?? 0);
  const priority = scoreLeadPriority(
    {
      websiteQualityScore: websiteQualityScore ?? 0,
      businessOpportunityScore,
      marketFitScore,
    },
    { weights: lpWeights, thresholds },
  );

  // --- 4. Persist (single transaction) ------------------------------------
  return db.transaction(async (tx) => {
    let websiteAnalysisId: string | null = null;
    if (websiteId) {
      const [analysisRow] = await tx
        .insert(websiteAnalyses)
        .values({
          website_id: websiteId,
          website_quality_score: websiteQualityScore ?? null,
          classification: websiteClassification as Classification,
          category_scores: categoryScores,
          test_results: testResults,
          evidence: analysisEvidence,
          critical_failures: criticalFailures,
          analysis_version: wsqVersion.id,
          analyzed_at: new Date(),
        })
        .returning({ id: websiteAnalyses.id });
      websiteAnalysisId = analysisRow!.id;
      await writeAuditTx(tx, {
        action: 'WEBSITE_ANALYZED',
        entityId: websiteId,
        metadata: {
          analysis_id: websiteAnalysisId,
          website_quality_score: websiteQualityScore,
          classification: websiteClassification,
          analysis_version: wsqVersion.id,
          weights: wsqWeights.weights,
        },
      });
      // Reflect the outcome on the website row itself (status → ANALYZED).
      await tx
        .update(websites)
        .set({ status: 'ANALYZED' })
        .where(eq(websites.id, websiteId));
    }

    const [leadScoreRow] = await tx
      .insert(leadScores)
      .values({
        business_id: businessId,
        website_quality_score: websiteQualityScore ?? null,
        business_opportunity_score: businessOpportunityScore,
        market_fit_score: String(priority.inputs.marketFitScore),
        lead_priority_score: String(priority.leadPriorityScore),
        classification: priority.classification,
        formula_fields: {
          inputs: {
            website_quality_score: websiteQualityScore,
            business_opportunity_score: businessOpportunityScore,
            market_fit_score: priority.inputs.marketFitScore,
            formula: 'lead_priority = (100 - wsq)*0.45 + bos*0.40 + market_fit*0.15',
          },
          weights: {
            website_quality: priority.weights.website_quality ?? 0,
            business_opportunity: priority.weights.business_opportunity ?? 0,
            market_fit: priority.weights.market_fit ?? 0,
          },
          formula_version: priority.formulaVersion,
          thresholds: priority.thresholds,
        } as FormulaFields,
        scoring_version: lpVersion.id,
      })
      .returning();
    const leadScoreId = leadScoreRow!.id;

    await writeAuditTx(tx, {
      action: 'LEAD_SCORED',
      entityId: businessId,
      metadata: {
        lead_score_id: leadScoreId,
        website_quality_score: websiteQualityScore,
        business_opportunity_score: businessOpportunityScore,
        market_fit_score: priority.inputs.marketFitScore,
        lead_priority_score: priority.leadPriorityScore,
        classification: priority.classification,
        scoring_version: lpVersion.id,
      },
    });

    return {
      businessId,
      websiteAnalysisId,
      leadScoreId,
      websiteQualityScore,
      businessOpportunityScore,
      marketFitScore: priority.inputs.marketFitScore,
      leadPriorityScore: priority.leadPriorityScore,
      leadClassification: priority.classification,
      scoringVersionId: lpVersion.id,
    };
  });
}

/** Latest lead_scores rows for a business (history kept — newest first). */
export async function getScoreHistory(businessId: string): Promise<typeof leadScores.$inferSelect[]> {
  return db
    .select()
    .from(leadScores)
    .where(eq(leadScores.business_id, businessId))
    .orderBy(desc(leadScores.created_at));
}

/* --- internal helpers ------------------------------------------------------ */

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

type Classification =
  | 'EXCELLENT'
  | 'GOOD'
  | 'AVERAGE'
  | 'WEAK'
  | 'VERY_WEAK'
  | 'NO_WEBSITE';

type FormulaFields = {
  inputs: Record<string, number | string | null>;
  weights: Record<string, number>;
  formula_version: string;
  thresholds: Record<string, number>;
};

async function writeAuditTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  event: {
    action: string;
    entityId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    actor_type: 'SYSTEM',
    actor_id: null,
    action: event.action,
    entity_type: 'business',
    entity_id: event.entityId,
    before: null,
    after: null,
    source: 'scoring',
    metadata: event.metadata,
  });
}