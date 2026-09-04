/**
 * Documented defaults for typed settings accessors.
 *
 * A fresh database may not be seeded yet (or a key may have been removed);
 * every accessor falls back to these spec defaults so nothing 500s. They mirror
 * exactly what src/db/seed.ts seeds — keep them in sync.
 */

export interface TargetIndustriesConfig {
  industries: string[];
}
export const DEFAULT_TARGET_INDUSTRIES: TargetIndustriesConfig = { industries: ['plumbing'] };

export interface TargetStatesConfig {
  states: string[];
}
export const DEFAULT_TARGET_STATES: TargetStatesConfig = { states: [] };

export interface WebsiteQualityWeightsConfig {
  weights: Record<string, number>;
}
export const DEFAULT_WEBSITE_QUALITY_WEIGHTS: WebsiteQualityWeightsConfig = {
  weights: { conversion: 25, mobile: 20, content: 15, trust: 15, technical: 15, design_ux: 10 },
};

export interface BusinessOpportunityWeightsConfig {
  weights: Record<string, number>;
}
export const DEFAULT_BUSINESS_OPPORTUNITY_WEIGHTS: BusinessOpportunityWeightsConfig = {
  weights: { viability: 25, demand: 25, ability_to_pay: 20, contactability: 20, icp_fit: 10 },
};

export interface LeadPriorityWeightsConfig {
  weights: Record<string, number>;
}
export const DEFAULT_LEAD_PRIORITY_WEIGHTS: LeadPriorityWeightsConfig = {
  weights: { website_quality: 0.45, business_opportunity: 0.4, market_fit: 0.15 },
};

export interface LeadClassificationThresholdsConfig {
  high_priority_min: number;
  secondary_min: number;
  review_min: number;
}
export const DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS: LeadClassificationThresholdsConfig = {
  high_priority_min: 80,
  secondary_min: 65,
  review_min: 50,
};

export interface RejectionRuleConfig {
  min_opportunity_score: number;
  excellent_website_min: number;
  min_contactability_score: number;
  inactive_statuses: string[];
}
export const DEFAULT_REJECTION_RULE_CONFIG: RejectionRuleConfig = {
  min_opportunity_score: 50,
  excellent_website_min: 90,
  min_contactability_score: 40,
  inactive_statuses: ['CLOSED', 'PERMANENTLY_CLOSED', 'TEMPORARILY_CLOSED'],
};

export interface FollowUpTimingConfig {
  day_offsets: number[];
}
export const DEFAULT_FOLLOWUP_TIMING: FollowUpTimingConfig = { day_offsets: [3, 7] };

export interface EmailLimitsConfig {
  outreach: number;
  followup: number;
  max_per_contact: number;
}
export const DEFAULT_EMAIL_LIMITS: EmailLimitsConfig = { outreach: 20, followup: 25, max_per_contact: 1 };

export interface PricingConfig {
  website_setup_fee_cents: number;
  hosting_monthly_cents: number;
}
export const DEFAULT_PRICING: PricingConfig = {
  website_setup_fee_cents: 150000,
  hosting_monthly_cents: 2900,
};

export interface NotificationRulesConfig {
  buying_intent: boolean;
  critical_exceptions: boolean;
  high_exceptions: boolean;
  digest: string;
}
export const DEFAULT_NOTIFICATION_RULES: NotificationRulesConfig = {
  buying_intent: true,
  critical_exceptions: true,
  high_exceptions: true,
  digest: 'daily',
};

export interface BusinessHoursConfig {
  timezone: string;
  workdays: number[];
  start: string;
  end: string;
}
export const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  timezone: 'America/Chicago',
  workdays: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '17:00',
};

/** Compliance guardrails — outreach must respect real limits. */
export const FEATURE_FLAG_DEFAULTS: Record<string, boolean> = {
  'flags.demo_generation_enabled': false,
  'flags.outreach_enabled': false,
  'flags.production_pipeline_enabled': false,
  'flags.billing_enabled': false,
};

export interface AiEvaluatorConfig {
  configured: boolean;
  provider?: string;
  model?: string;
  promptRef?: string;
}
export const DEFAULT_AI_EVALUATOR_CONFIG: AiEvaluatorConfig = { configured: false };