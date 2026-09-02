/**
 * Config backend for the scoring engines.
 *
 * Three sources, in order of authority:
 *  1. `system_settings` — business rules the owner edits from Settings
 *     (category weights, formulas, thresholds). Falls back to master-spec
 *     defaults when a key is absent.
 *  2. `scoring_versions` — versioned, immutable weight snapshots. The active
 *     version per score_type is the one analyses/lead-scores reference.
 *  3. TypeScript constants in this module — only the default fallbacks (none
 *     business-rule-shaped beyond the spec's own published constants).
 *
 * Weights and thresholds are config, NOT env — .env.example stays untouched for
 * them. The only env-dependent pieces are the AI-subjective-evaluator settings
 * (see config readers at the bottom; keys documented in .env.example).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { systemSettings, scoringVersions } from '../db/schema.js';
import type { ScoringType, ScoringVersion } from './types.js';
import { ScoringError } from './types.js';

/** Master-spec category weights for the website quality score (v1). */
export const DEFAULT_WEBSITE_QUALITY_WEIGHTS: Record<string, number> = {
  conversion: 25,
  mobile: 20,
  content: 15,
  trust: 15,
  technical: 15,
  design_ux: 10,
};

/** Master-spec category weights for the business opportunity score (v1). */
export const DEFAULT_BUSINESS_OPPORTUNITY_WEIGHTS: Record<string, number> = {
  viability: 25,
  demand: 25,
  ability_to_pay: 20,
  contactability: 20,
  icp_fit: 10,
};

/** Master-spec lead priority formula weights (v1). */
export const DEFAULT_LEAD_PRIORITY_WEIGHTS: Record<string, number> = {
  website_quality: 0.45,
  business_opportunity: 0.4,
  market_fit: 0.15,
};

/** Master-spec website classification bands (fixed by the spec, not config). */
export const WEBSITE_CLASSIFICATION_BANDS = {
  excellent_min: 90,
  good_min: 75,
  average_min: 60,
  weak_min: 40,
} as const;

/** Master-spec lead classification thresholds (configurable). */
export const DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS = {
  high_priority_min: 80,
  secondary_min: 65,
  review_min: 50,
} as const;

/** Target ICP config read from system_settings (target.industries/states). */
export interface TargetConfig {
  industries: string[];
  states: string[];
}

export const DEFAULT_TARGET_CONFIG: TargetConfig = {
  industries: ['plumbing'],
  states: [],
};

/* ---------------------------------------------------------------------------
 * system_settings readers
 * ------------------------------------------------------------------------- */

/** Read one system_settings key. Returns undefined when the key is absent. */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const rows = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  return rows[0]?.value as T | undefined;
}

/** Website quality category weights + the source key they came from. */
export interface WebsiteQualityWeights {
  weights: Record<string, number>;
  sourceKey: string;
}

/** Read website-quality weights (system_settings → spec defaults). */
export async function getWebsiteQualityWeights(): Promise<WebsiteQualityWeights> {
  const key = 'scoring.website_quality.weights';
  const stored = await getSetting<Record<string, number>>(key);
  return { weights: { ...DEFAULT_WEBSITE_QUALITY_WEIGHTS, ...(stored ?? {}) }, sourceKey: key };
}

/** Business opportunity category weights + the source key they came from. */
export interface BusinessOpportunityWeights {
  weights: Record<string, number>;
  sourceKey: string;
}

/** Read business-opportunity weights (system_settings → spec defaults). */
export async function getBusinessOpportunityWeights(): Promise<BusinessOpportunityWeights> {
  const key = 'scoring.business_opportunity.weights';
  const stored = await getSetting<Record<string, number>>(key);
  return { weights: { ...DEFAULT_BUSINESS_OPPORTUNITY_WEIGHTS, ...(stored ?? {}) }, sourceKey: key };
}

/** Lead priority formula weights + the source key they came from. */
export interface LeadPriorityWeights {
  weights: Record<string, number>;
  sourceKey: string;
}

/** Read lead-priority formula weights (system_settings → spec defaults). */
export async function getLeadPriorityWeights(): Promise<LeadPriorityWeights> {
  const key = 'scoring.lead_priority.formula';
  const stored = await getSetting<Record<string, number>>(key);
  return { weights: { ...DEFAULT_LEAD_PRIORITY_WEIGHTS, ...(stored ?? {}) }, sourceKey: key };
}

/** Read lead classification thresholds (system_settings → spec defaults). */
export async function getLeadClassificationThresholds(): Promise<{
  high_priority_min: number;
  secondary_min: number;
  review_min: number;
}> {
  const key = 'scoring.lead_classification.thresholds';
  const stored = await getSetting<{
    high_priority_min?: number;
    secondary_min?: number;
    review_min?: number;
  }>(key);
  return {
    high_priority_min: stored?.high_priority_min ?? DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS.high_priority_min,
    secondary_min: stored?.secondary_min ?? DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS.secondary_min,
    review_min: stored?.review_min ?? DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS.review_min,
  };
}

/** Read the target ICP (target.industries / target.states) from Settings. */
export async function getTargetConfig(): Promise<TargetConfig> {
  const [industries, states] = await Promise.all([
    getSetting<string[] | null>('target.industries'),
    getSetting<string[] | null>('target.states'),
  ]);
  return {
    industries: (industries ?? DEFAULT_TARGET_CONFIG.industries).map((s) => s.trim().toLowerCase()).filter(Boolean),
    states: (states ?? DEFAULT_TARGET_CONFIG.states).map((s) => s.trim().toUpperCase()).filter(Boolean),
  };
}

/* ---------------------------------------------------------------------------
 * scoring_versions resolution
 * ------------------------------------------------------------------------- */

/** Look up the active scoring version for a score type. Throws when absent. */
export async function getActiveScoringVersion(scoreType: ScoringType): Promise<ScoringVersion> {
  const rows = await db
    .select()
    .from(scoringVersions)
    .where(and(eq(scoringVersions.score_type, scoreType), eq(scoringVersions.is_active, true)))
    .orderBy(scoringVersions.version)
    .limit(1);
  if (!rows[0]) {
    throw new ScoringError(
      'EVALUATOR_NOT_CONFIGURED',
      `No active scoring_versions row for score_type=${scoreType} — seed the DB (npm run db:seed).`,
    );
  }
  return rows[0]!;
}

/* ---------------------------------------------------------------------------
 * AI subjective evaluator configuration (requires-configuration)
 * ------------------------------------------------------------------------- */

/** AI subjective evaluator settings sourced from system_settings (keys
 *  `ai.evaluator.provider` / `ai.evaluator.model` / `ai.evaluator.prompt`,
 *  which the owner configures — nothing hard-coded) with the env credentials
 *  read from AI_EVALUATOR_API_* (see .env.example). */
export interface AiEvaluatorConfig {
  configured: boolean;
  provider?: string;
  model?: string;
  promptRef?: string;
}

/** Read AI evaluator config; configured=false until provider/model AND the
 *  AI_EVALUATOR_API_* credentials are both present. No fake integrations. */
export async function getAiEvaluatorConfig(): Promise<AiEvaluatorConfig> {
  const [provider, model, promptRef] = await Promise.all([
    getSetting<string>('ai.evaluator.provider'),
    getSetting<string>('ai.evaluator.model'),
    getSetting<string>('ai.evaluator.prompt'),
  ]);
  const hasApiKey = Boolean(process.env.AI_EVALUATOR_API_URL || process.env.AI_EVALUATOR_API_KEY);
  const configured = Boolean(provider && model && promptRef && hasApiKey);
  return { configured, provider, model, promptRef };
}