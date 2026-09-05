/**
 * Typed settings accessors — the platform-wide way to read business rules.
 *
 * Every accessor:
 *   - reads the JSONB value from system_settings through the shared
 *     SettingsService (cached, typed),
 *   - applies a type guard,
 *   - falls back to the documented default from src/config/defaults.ts when
 *     the key is missing or its stored value is corrupt (never 500s).
 *
 * The AI evaluator config intentionally maps to the AI_EVALUATOR_* env
 * placeholders (brief 4) so it stays config-shaped: provider/model/prompt come
 * from Settings, credentials from env — `configured: false` until BOTH exist.
 * No fake integrations.
 */
import { SettingsService } from './service';
import * as D from './defaults';

// Re-export upstream constant types so existing callers of scoring/lifecycle
// config keep working under one roof (see src/scoring/config.ts / src/lifecycle/config.ts).
export type {
  TargetIndustriesConfig,
  TargetStatesConfig,
  WebsiteQualityWeightsConfig,
  BusinessOpportunityWeightsConfig,
  LeadPriorityWeightsConfig,
  LeadClassificationThresholdsConfig,
  RejectionRuleConfig,
  FollowUpTimingConfig,
  EmailLimitsConfig,
  PricingConfig,
  NotificationRulesConfig,
  BusinessHoursConfig,
  AiEvaluatorConfig,
  DiscoveryConfig,
} from './defaults';

const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNumRecord = (v: unknown): v is Record<string, number> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every((x) => typeof x === 'number' && Number.isFinite(x));
const isNumArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isBoolRecord = (v: unknown): v is Record<string, boolean> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every((x) => typeof x === 'boolean');

/** Weighted score configs: normalize into { weights } + sourceKey for callers. */
async function weightsFor(service: SettingsService, key: string, fallback: Record<string, number>) {
  const parsed = await service.getParsed<Record<string, number>>(key, isNumRecord, fallback);
  return { weights: parsed, sourceKey: key };
}

/**
 * Bind typed accessors to a SettingsService instance (default: the app-wide
 * singleton). Returns plain functions; callers pass the service when testing.
 */
export function createSettingsAccessors(service: SettingsService) {
  return {
    /** target.industries → string[] (lowercased, trimmed). */
    getTargetIndustries(): Promise<string[]> {
      return service.getParsed<string[]>(
        'target.industries',
        isStrArray,
        D.DEFAULT_TARGET_INDUSTRIES.industries,
      ).then((v) => v.map((s) => s.trim().toLowerCase()).filter(Boolean));
    },

    /** target.states → string[] (uppercased 2-letter codes). */
    getTargetStates(): Promise<string[]> {
      return service.getParsed<string[]>(
        'target.states',
        isStrArray,
        D.DEFAULT_TARGET_STATES.states,
      ).then((v) => v.map((s) => s.trim().toUpperCase()).filter(Boolean));
    },

    /** target.cities → string[] (trimmed, deduped case-insensitively). */
    getTargetCities(): Promise<string[]> {
      return service.getParsed<string[]>(
        'target.cities',
        isStrArray,
        [],
      ).then((v) => [...new Set(v.map((s) => s.trim().toLowerCase()).filter(Boolean))]);
    },

    /** Scoring weights for a score type — key-specific defaults. */
    async getScoringWeights(scoreType: 'website_quality' | 'business_opportunity' | 'lead_priority') {
      switch (scoreType) {
        case 'website_quality':
          return weightsFor(service, 'scoring.website_quality.weights', D.DEFAULT_WEBSITE_QUALITY_WEIGHTS.weights);
        case 'business_opportunity':
          return weightsFor(service, 'scoring.business_opportunity.weights', D.DEFAULT_BUSINESS_OPPORTUNITY_WEIGHTS.weights);
        case 'lead_priority':
          return weightsFor(service, 'scoring.lead_priority.formula', D.DEFAULT_LEAD_PRIORITY_WEIGHTS.weights);
      }
    },

    /** Lead classification thresholds (scoring.lead_classification.thresholds). */
    async getLeadThresholds(): Promise<D.LeadClassificationThresholdsConfig> {
      const src = await service.getParsed<Partial<D.LeadClassificationThresholdsConfig>>(
        'scoring.lead_classification.thresholds',
        (v): v is Partial<D.LeadClassificationThresholdsConfig> => isNumRecord(v),
        {},
      );
      return {
        high_priority_min: src.high_priority_min ?? D.DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS.high_priority_min,
        secondary_min: src.secondary_min ?? D.DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS.secondary_min,
        review_min: src.review_min ?? D.DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS.review_min,
      };
    },

    /** Rejection-rule thresholds (scoring.rejection.thresholds). */
    async getRejectionRuleConfig(): Promise<D.RejectionRuleConfig> {
      const src = await service.getParsed<Partial<D.RejectionRuleConfig>>(
        'scoring.rejection.thresholds',
        (v): v is Partial<D.RejectionRuleConfig> =>
          v !== null && typeof v === 'object' && !Array.isArray(v),
        {},
      );
      return {
        min_opportunity_score:
          src.min_opportunity_score ?? D.DEFAULT_REJECTION_RULE_CONFIG.min_opportunity_score,
        excellent_website_min:
          src.excellent_website_min ?? D.DEFAULT_REJECTION_RULE_CONFIG.excellent_website_min,
        min_contactability_score:
          src.min_contactability_score ?? D.DEFAULT_REJECTION_RULE_CONFIG.min_contactability_score,
        inactive_statuses:
          src.inactive_statuses ?? D.DEFAULT_REJECTION_RULE_CONFIG.inactive_statuses,
      };
    },

    /** Follow-up timing in days after the previous message (outreach.followup.day_offsets). */
    async getFollowUpTiming(): Promise<D.FollowUpTimingConfig> {
      const day_offsets = await service.getParsed<number[]>(
        'outreach.followup.day_offsets',
        isNumArray,
        D.DEFAULT_FOLLOWUP_TIMING.day_offsets,
      );
      return { day_offsets };
    },

    /** Email daily limits (outreach.email.daily_limit). */
    async getEmailLimits(): Promise<D.EmailLimitsConfig> {
      const src = await service.getParsed<Partial<D.EmailLimitsConfig>>(
        'outreach.email.daily_limit',
        (v): v is Partial<D.EmailLimitsConfig> => isNumRecord(v),
        {},
      );
      return {
        outreach: src.outreach ?? D.DEFAULT_EMAIL_LIMITS.outreach,
        followup: src.followup ?? D.DEFAULT_EMAIL_LIMITS.followup,
        max_per_contact: src.max_per_contact ?? D.DEFAULT_EMAIL_LIMITS.max_per_contact,
      };
    },

    /** Pricing (pricing.website_setup_fee_cents / pricing.hosting_monthly_cents). */
    async getPricing(): Promise<D.PricingConfig> {
      const [setup, monthly] = await Promise.all([
        service.getParsed<number>('pricing.website_setup_fee_cents', (v): v is number => typeof v === 'number', D.DEFAULT_PRICING.website_setup_fee_cents),
        service.getParsed<number>('pricing.hosting_monthly_cents', (v): v is number => typeof v === 'number', D.DEFAULT_PRICING.hosting_monthly_cents),
      ]);
      return { website_setup_fee_cents: setup, hosting_monthly_cents: monthly };
    },

    /** Which events notify the owner (notifications.rules). */
    async getNotificationRules(): Promise<D.NotificationRulesConfig> {
      const src = await service.getParsed<Partial<D.NotificationRulesConfig>>(
        'notifications.rules',
        (v): v is Partial<D.NotificationRulesConfig> => isBoolRecord(v),
        {},
      );
      return {
        buying_intent: src.buying_intent ?? D.DEFAULT_NOTIFICATION_RULES.buying_intent,
        critical_exceptions: src.critical_exceptions ?? D.DEFAULT_NOTIFICATION_RULES.critical_exceptions,
        high_exceptions: src.high_exceptions ?? D.DEFAULT_NOTIFICATION_RULES.high_exceptions,
        digest: typeof src.digest === 'string' ? src.digest : D.DEFAULT_NOTIFICATION_RULES.digest,
      };
    },

    /** Operating hours used to schedule outreach (business.hours). */
    async getBusinessHours(): Promise<D.BusinessHoursConfig> {
      const src = await service.getParsed<Partial<D.BusinessHoursConfig>>(
        'business.hours',
        (v): v is Partial<D.BusinessHoursConfig> => isNumRecord(v),
        {},
      );
      const workdays = isNumArray(src.workdays) ? src.workdays : D.DEFAULT_BUSINESS_HOURS.workdays;
      return {
        timezone: typeof src.timezone === 'string' ? src.timezone : D.DEFAULT_BUSINESS_HOURS.timezone,
        workdays,
        start: typeof src.start === 'string' ? src.start : D.DEFAULT_BUSINESS_HOURS.start,
        end: typeof src.end === 'string' ? src.end : D.DEFAULT_BUSINESS_HOURS.end,
      };
    },

    /**
     * Feature flag by name (flags.*). Defaults to false unless explicitly true
     * in Settings — flags gate later-brief pipelines so nothing runs early.
     */
    async getFeatureFlag(name: string): Promise<boolean> {
      const fallback = FEATURE_FLAG_DEFAULTS[name];
      const v = await service.getParsed<unknown>(name, (x): x is unknown => true, fallback ?? false);
      return isBool(v) ? v : (fallback ?? false);
    },

    /**
     * AI subjective evaluator config. Settings hold provider/model/prompt;
     * credentials come from the AI_EVALUATOR_API_* env placeholders. Only
     * `configured: true` when BOTH are present — no fake integrations.
     */
    async getAiEvaluatorConfig(): Promise<D.AiEvaluatorConfig> {
      const [provider, model, promptRef] = await Promise.all([
        service.getParsed<string>('ai.evaluator.provider', (v): v is string => typeof v === 'string', ''),
        service.getParsed<string>('ai.evaluator.model', (v): v is string => typeof v === 'string', ''),
        service.getParsed<string>('ai.evaluator.prompt', (v): v is string => typeof v === 'string', ''),
      ]);
      const hasApiKey = Boolean(process.env.AI_EVALUATOR_API_URL || process.env.AI_EVALUATOR_API_KEY);
      const configured = Boolean(provider && model && promptRef && hasApiKey);
      return { configured, provider: provider || undefined, model: model || undefined, promptRef: promptRef || undefined };
    },

    /** Discovery provider selection (integrations.discovery.provider). */
    getDiscoveryProvider(): Promise<string> {
      return service.getParsed<string>(
        'integrations.discovery.provider',
        (v): v is string => typeof v === 'string',
        D.DEFAULT_DISCOVERY_PROVIDER,
      );
    },

    /** Discovery job runtime limits (discovery.*). */
    async getDiscoveryConfig(): Promise<D.DiscoveryConfig> {
      const isNonNegativeInt = (v: unknown): v is number =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0;
      const [batch_size, max_attempts, schedule_interval_minutes, rate_limit_per_minute] = await Promise.all([
        service.getParsed<number>('discovery.batch_size', isNonNegativeInt, D.DEFAULT_DISCOVERY_CONFIG.batch_size),
        service.getParsed<number>('discovery.max_attempts', isNonNegativeInt, D.DEFAULT_DISCOVERY_CONFIG.max_attempts),
        service.getParsed<number>('discovery.schedule_interval_minutes', isNonNegativeInt, D.DEFAULT_DISCOVERY_CONFIG.schedule_interval_minutes),
        service.getParsed<number>('discovery.rate_limit_per_minute', isNonNegativeInt, D.DEFAULT_DISCOVERY_CONFIG.rate_limit_per_minute),
      ]);
      return {
        batch_size: Math.max(batch_size, 1),
        max_attempts: Math.max(max_attempts, 1),
        schedule_interval_minutes,
        rate_limit_per_minute,
      };
    },
  };
}

export type SettingsAccessors = ReturnType<typeof createSettingsAccessors>;

const FEATURE_FLAG_DEFAULTS = D.FEATURE_FLAG_DEFAULTS;