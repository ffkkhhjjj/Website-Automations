/**
 * Config backend for the scoring engines.
 *
 * Three sources, in order of authority:
 *  1. `system_settings` — business rules the owner edits from Settings
 *     (category weights, formulas, thresholds). Falls back to master-spec
 *     defaults when a key is absent. Read through the shared SettingsService
 *     (src/config) — typed, validated, cached.
 *  2. `scoring_versions` — versioned, immutable weight snapshots. The active
 *     version per score_type is the one analyses/lead-scores reference.
 *  3. TypeScript constants in this module — only the default fallbacks (none
 *     business-rule-shaped beyond the spec's own published constants).
 *
 * Weights and thresholds are config, NOT env — .env.example stays untouched for
 * them. The only env-dependent pieces are the AI-subjective-evaluator settings
 * (see config readers at the bottom; keys documented in .env.example).
 *
 * The typed getters here delegate to src/config/accessors; signatures are
 * unchanged so existing callers (orchestrator, tests) keep working.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scoringVersions } from '../db/schema.js';
import type { ScoringType, ScoringVersion } from './types.js';
import { ScoringError } from './types.js';
import { settings } from '../config/singleton';
import { settingsService } from '../config/singleton';
import * as D from '../config/defaults';

/** Master-spec category weights for the website quality score (v1). */
export const DEFAULT_WEBSITE_QUALITY_WEIGHTS: Record<string, number> =
  D.DEFAULT_WEBSITE_QUALITY_WEIGHTS.weights;

/** Master-spec category weights for the business opportunity score (v1). */
export const DEFAULT_BUSINESS_OPPORTUNITY_WEIGHTS: Record<string, number> =
  D.DEFAULT_BUSINESS_OPPORTUNITY_WEIGHTS.weights;

/** Master-spec lead priority formula weights (v1). */
export const DEFAULT_LEAD_PRIORITY_WEIGHTS: Record<string, number> =
  D.DEFAULT_LEAD_PRIORITY_WEIGHTS.weights;

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
 * system_settings readers (delegated to the shared SettingsService)
 * ------------------------------------------------------------------------- */

/** Read one system_settings key. Returns undefined when the key is absent. */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await settingsService.get(key).catch(() => undefined);
  return row?.value as T | undefined;
}

/** Website quality category weights + the source key they came from. */
export interface WebsiteQualityWeights {
  weights: Record<string, number>;
  sourceKey: string;
}

/** Read website-quality weights (system_settings → spec defaults). */
export async function getWebsiteQualityWeights(): Promise<WebsiteQualityWeights> {
  return settings.getScoringWeights('website_quality');
}

/** Business opportunity category weights + the source key they came from. */
export interface BusinessOpportunityWeights {
  weights: Record<string, number>;
  sourceKey: string;
}

/** Read business-opportunity weights (system_settings → spec defaults). */
export async function getBusinessOpportunityWeights(): Promise<BusinessOpportunityWeights> {
  return settings.getScoringWeights('business_opportunity');
}

/** Lead priority formula weights + the source key they came from. */
export interface LeadPriorityWeights {
  weights: Record<string, number>;
  sourceKey: string;
}

/** Read lead-priority formula weights (system_settings → spec defaults). */
export async function getLeadPriorityWeights(): Promise<LeadPriorityWeights> {
  return settings.getScoringWeights('lead_priority');
}

/** Read lead classification thresholds (system_settings → spec defaults). */
export async function getLeadClassificationThresholds(): Promise<{
  high_priority_min: number;
  secondary_min: number;
  review_min: number;
}> {
  return settings.getLeadThresholds();
}

/** Read the target ICP (target.industries / target.states) from Settings. */
export async function getTargetConfig(): Promise<TargetConfig> {
  const [industries, states] = await Promise.all([
    settings.getTargetIndustries(),
    settings.getTargetStates(),
  ]);
  return { industries, states };
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
  return settings.getAiEvaluatorConfig();
}