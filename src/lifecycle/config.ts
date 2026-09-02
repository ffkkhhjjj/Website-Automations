/**
 * Config helpers for the lifecycle module.
 *
 * Business rules live in system_settings (never hard-coded business values).
 * This module reads the keys needed by the rejection rules and the lead
 * classification thresholds, falling back to conservative defaults that match
 * the master spec when a key is missing (it may not be seeded yet in some
 * environments). Thresholds are config, not env — .env.example is untouched.
 */
import { db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/** Raw value shape of the scoring.lead_classification.thresholds setting. */
export interface LeadClassificationThresholds {
  high_priority_min: number;
  secondary_min: number;
  review_min: number;
}

/** Defaults match the seeded value (spec: >=80 HIGH_PRIORITY, >=65 SECONDARY, >=50 REVIEW, <50 REJECT). */
export const DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS: LeadClassificationThresholds = {
  high_priority_min: 80,
  secondary_min: 65,
  review_min: 50,
};

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
export const DEFAULT_REJECTION_RULE_CONFIG: RejectionRuleConfig = {
  min_opportunity_score: 50,
  excellent_website_min: 90,
  min_contactability_score: 40,
  inactive_statuses: ['CLOSED', 'PERMANENTLY_CLOSED', 'TEMPORARILY_CLOSED'],
};

/** Read one system_setting key. Returns undefined when the key is absent. */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const rows = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  return rows[0]?.value as T | undefined;
}

/** Read the rejection-rule config, merging any stored JSON over the defaults. */
export async function getRejectionRuleConfig(): Promise<RejectionRuleConfig> {
  const stored = await getSetting<Partial<RejectionRuleConfig>>('scoring.rejection.thresholds');
  return { ...DEFAULT_REJECTION_RULE_CONFIG, ...(stored ?? {}) };
}

/** Read the lead classification thresholds (scoring.lead_classification.thresholds). */
export async function getLeadClassificationThresholds(): Promise<LeadClassificationThresholds> {
  const stored = await getSetting<Partial<LeadClassificationThresholds>>(
    'scoring.lead_classification.thresholds',
  );
  return { ...DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS, ...(stored ?? {}) };
}