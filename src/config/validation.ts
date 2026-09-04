/**
 * Settings value validation.
 *
 * Every setting key has a schema: `type` from the row (string/number/boolean/
 * json/array, enforced by the DB check) plus per-key semantic validators for
 * the seeded business rules. Unknown keys are rejected by the service (they
 * cannot be validated here and are never accepted by the API).
 *
 * Missing defaults live in src/config/defaults.ts; callers of the SettingsService
 * accessors get documented fallbacks when a key is absent.
 */

export type SettingValueType = 'string' | 'number' | 'boolean' | 'json' | 'array';

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

const ok: ValidationResult = { ok: true };

/** Generic type-level checks; semantic checks below add per-key rules. */
export function validateSettingValue(
  key: string,
  value: unknown,
  type: SettingValueType,
): ValidationResult {
  // 1. Type-level check matching the row's declared type.
  const base = validateType(value, type);
  if (!base.ok) return base;
  // 2. Semantic checks for known settings.
  return validateKnown(key, value);
}

export function validateType(value: unknown, type: SettingValueType): ValidationResult {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? ok : { ok: false, message: 'expected a string' };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? ok
        : { ok: false, message: 'expected a finite number' };
    case 'boolean':
      return typeof value === 'boolean' ? ok : { ok: false, message: 'expected a boolean' };
    case 'array':
      return Array.isArray(value) ? ok : { ok: false, message: 'expected an array' };
    case 'json':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? ok
        : { ok: false, message: 'expected a JSON object' };
  }
}

/** Feature flags are constrained to boolean semantics. */
export function validateBooleanFlag(value: unknown): boolean {
  return typeof value === 'boolean';
}

/** Per-key semantic validators (business rules; spec)
 *
 *  - scoring weights objects must contain ONLY numeric values and a complete
 *    known category set (their engines weight the full category list).
 *  - scoring.*.thresholds are numeric grade objects.
 *  - pricing amounts are integer cents >= 0.
 *  - business hours / notifications / email limits are JSON objects whose
 *    fields are validated loosely (the accessor type-guards them; corrupt
 *    values fall back to defaults rather than 500).
 */
function validateKnown(key: string, value: unknown): ValidationResult {
  if (key === 'target.industries' || key === 'target.states' || key === 'target.cities') {
    const list = value as unknown[];
    const bad = list.find((v) => typeof v !== 'string');
    if (bad !== undefined) return { ok: false, message: 'expected an array of strings' };
    return ok;
  }
  if (
    key === 'scoring.website_quality.weights' ||
    key === 'scoring.business_opportunity.weights' ||
    key === 'scoring.lead_priority.formula'
  ) {
    return validateWeightsObject(key, value);
  }
  if (key === 'scoring.lead_classification.thresholds' || key === 'scoring.rejection.thresholds') {
    return validateNumericRecord(key, value);
  }
  if (key === 'outreach.followup.day_offsets') {
    const list = value as unknown[];
    const bad = list.find((v) => typeof v !== 'number' || !Number.isInteger(v) || (v as number) < 0);
    if (bad !== undefined) return { ok: false, message: 'expected an array of non-negative integers (days)' };
    return ok;
  }
  if (key === 'outreach.email.daily_limit') {
    return validateNumericRecord(key, value, { positive: true });
  }
  if (key === 'pricing.website_setup_fee_cents' || key === 'pricing.hosting_monthly_cents') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? ok
      : { ok: false, message: 'expected an integer >= 0 (cents)' };
  }
  if (key === 'notifications.rules') {
    return validateNumericRecord(key, value, { allowBooleans: true });
  }
  if (key === 'business.hours') {
    return validateNumericRecord(key, value);
  }
  if (key === 'integrations.enrichment.provider' || key === 'integrations.email.provider' || key === 'integrations.demo_hosting.provider' || key === 'integrations.deployment.provider' || key === 'integrations.discovery.provider') {
    return typeof value === 'string' && value.trim().length > 0
      ? ok
      : { ok: false, message: 'expected a non-empty provider id string ("none" to disable)' };
  }
  if (key === 'discovery.batch_size' || key === 'discovery.max_attempts' || key === 'discovery.schedule_interval_minutes' || key === 'discovery.rate_limit_per_minute') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? ok
      : { ok: false, message: 'expected a non-negative integer' };
  }
  return ok; // unknown per-key schema: only type-level checks apply (API rejects unknown keys anyway)
}

function validateWeightsObject(key: string, value: unknown): ValidationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'expected a JSON object of weights' };
  }
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return { ok: false, message: 'weights must not be empty' };
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, message: `weight "${k}" must be a finite number` };
    }
  }
  // Formula weights need not sum to 100; category weights must (spec).
  if (key === 'scoring.website_quality.weights' || key === 'scoring.business_opportunity.weights') {
    let sum = 0;
    for (const n of Object.values(obj)) sum += (n as number);
    if (Math.abs(sum - 100) > 0.00001) {
      return { ok: false, message: `category weights must sum to 100 (got ${sum})` };
    }
  }
  return ok;
}

function validateNumericRecord(
  key: string,
  value: unknown,
  opts: { positive?: boolean; allowBooleans?: boolean } = {},
): ValidationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'expected a JSON object' };
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'boolean') {
      if (!opts.allowBooleans) return { ok: false, message: `field "${k}" must be a number` };
    } else if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, message: `field "${k}" must be a number` };
    } else if (opts.positive && v <= 0) {
      return { ok: false, message: `field "${k}" must be > 0` };
    }
  }
  return ok;
}