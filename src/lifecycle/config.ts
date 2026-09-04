/**
 * Config helpers for the lifecycle module.
 *
 * Business rules live in system_settings (never hard-coded business values),
 * read through the shared SettingsService (src/config) — typed, validated,
 * cached, with documented spec defaults when a key is missing. Thresholds are
 * config, not env — .env.example is untouched.
 *
 * Public API is unchanged from the standalone readers (callers keep working).
 */
import { settingsService } from '../config/singleton';
import { settings } from '../config/singleton';
import * as D from '../config/defaults';

/** Raw value shape of the scoring.lead_classification.thresholds setting. */
export interface LeadClassificationThresholds {
  high_priority_min: number;
  secondary_min: number;
  review_min: number;
}

/** Defaults match the seeded value (spec: >=80 HIGH_PRIORITY, >=65 SECONDARY, >=50 REVIEW, <50 REJECT). */
export const DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS: LeadClassificationThresholds =
  D.DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS;

/** Master-spec website classification bands (spec, fixed — not config). */
export interface WebsiteClassificationBands {
  excellent_min: number;
  good_min: number;
  average_min: number;
  weak_min: number;
}

export const WEBSITE_CLASSIFICATION_BANDS: WebsiteClassificationBands = {
  excellent_min: 90,
  good_min: 75,
  average_min: 60,
  weak_min: 40,
};

/** Config for the automated rejection rules. */
export interface RejectionRuleConfig {
  /** Business opportunity score below this → LOW_OPPORTUNITY. */
  min_opportunity_score: number;
  /** Website quality score at/above this → EXCELLENT_WEBSITE. */
  excellent_website_min: number;
  /** Contactability score below this → NO_CONTACT_ROUTE. */
  min_contactability_score: number;
  /** Business operational statuses treated as inactive. */
  inactive_statuses: string[];
}

/** Conservative defaults; overridden by system_settings key `scoring.rejection.thresholds`. */
export const DEFAULT_REJECTION_RULE_CONFIG: RejectionRuleConfig =
  D.DEFAULT_REJECTION_RULE_CONFIG;

/** Read one system_setting key (raw). Returns undefined when the key is absent. */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await settingsService.get(key).catch(() => undefined);
  return row?.value as T | undefined;
}

/** Read the rejection-rule config, merging any stored JSON over the defaults. */
export async function getRejectionRuleConfig(): Promise<RejectionRuleConfig> {
  return settings.getRejectionRuleConfig();
}

/** Read the lead classification thresholds (scoring.lead_classification.thresholds). */
export async function getLeadClassificationThresholds(): Promise<LeadClassificationThresholds> {
  return settings.getLeadThresholds();
}