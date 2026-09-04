/**
 * Seed data for system_settings — shared by the idempotent seed script and the
 * test bootstrap (fresh throwaway DBs get the same defaults). Kept here so the
 * tests can seed without running the whole src/db/seed.ts CLI (which closes the
 * pool and would interfere with vitest).
 *
 * Values mirror the master spec; change via Settings, never in code.
 */
import { sql } from 'drizzle-orm';
import { db } from './client';

export interface SeedSetting {
  key: string;
  value: unknown;
  type: 'string' | 'number' | 'boolean' | 'json' | 'array';
  description: string;
  is_feature_flag: boolean;
}

const DEFAULT_SETTINGS: SeedSetting[] = [
  {
    key: 'target.industries',
    value: ['plumbing'],
    type: 'array',
    description: 'Industries the platform targets for website-sales outreach.',
    is_feature_flag: false,
  },
  {
    key: 'target.states',
    value: [],
    type: 'array',
    description: 'US states (2-letter) the platform operates in. Empty = set from Settings before enabling outreach.',
    is_feature_flag: false,
  },
  {
    key: 'target.cities',
    value: [],
    type: 'array',
    description: 'Cities targeted for discovery. Empty = set from Settings before enabling discovery.',
    is_feature_flag: false,
  },
  {
    key: 'scoring.website_quality.weights',
    value: { conversion: 25, mobile: 20, content: 15, trust: 15, technical: 15, design_ux: 10 },
    type: 'json',
    description: 'Category weights (must sum to 100) for the website quality score.',
    is_feature_flag: false,
  },
  {
    key: 'scoring.business_opportunity.weights',
    value: { viability: 25, demand: 25, ability_to_pay: 20, contactability: 20, icp_fit: 10 },
    type: 'json',
    description: 'Category weights (must sum to 100) for the business opportunity score.',
    is_feature_flag: false,
  },
  {
    key: 'scoring.lead_priority.formula',
    value: { website_quality: 0.45, business_opportunity: 0.4, market_fit: 0.15 },
    type: 'json',
    description: 'Lead priority formula weights. lead_priority = (100 - website_quality)*0.45 + business_opportunity*0.40 + market_fit*0.15.',
    is_feature_flag: false,
  },
  {
    key: 'scoring.lead_classification.thresholds',
    value: { high_priority_min: 80, secondary_min: 65, review_min: 50 },
    type: 'json',
    description: 'Priority-score thresholds: >=80 HIGH_PRIORITY, >=65 SECONDARY, >=50 REVIEW, <50 REJECT.',
    is_feature_flag: false,
  },
  {
    key: 'scoring.rejection.thresholds',
    value: {
      min_opportunity_score: 50,
      excellent_website_min: 90,
      min_contactability_score: 40,
      inactive_statuses: ['CLOSED', 'PERMANENTLY_CLOSED', 'TEMPORARILY_CLOSED'],
    },
    type: 'json',
    description: 'Automated rejection rule thresholds (lifecycle): opportunity below min → LOW_OPPORTUNITY; website score at/above excellent_website_min → EXCELLENT_WEBSITE; contactability below min or no route → NO_CONTACT_ROUTE; listed statuses → INACTIVE_BUSINESS.',
    is_feature_flag: false,
  },
  {
    key: 'outreach.followup.day_offsets',
    value: [3, 7],
    type: 'array',
    description: 'Follow-up sequence timing in days after the previous message (steps 1, 2).',
    is_feature_flag: false,
  },
  {
    key: 'outreach.email.daily_limit',
    value: { outreach: 20, followup: 25, max_per_contact: 1 },
    type: 'json',
    description: 'Daily email sending limits for outreach and follow-ups.',
    is_feature_flag: false,
  },
  {
    key: 'pricing.website_setup_fee_cents',
    value: 150000,
    type: 'number',
    description: 'One-time website build setup fee, in cents (default $1,500).',
    is_feature_flag: false,
  },
  {
    key: 'pricing.hosting_monthly_cents',
    value: 2900,
    type: 'number',
    description: 'Recurring hosting/maintenance fee per month, in cents (default $29).',
    is_feature_flag: false,
  },
  {
    key: 'notifications.rules',
    value: { buying_intent: true, critical_exceptions: true, high_exceptions: true, digest: 'daily' },
    type: 'json',
    description: 'Which events notify the owner. Buying intent + exceptions only by default.',
    is_feature_flag: false,
  },
  {
    key: 'notifications.hot_lead_limit',
    value: 10,
    type: 'number',
    description: 'Maximum number of hot leads shown on the owner dashboard (top-N by lead priority).',
    is_feature_flag: false,
  },
  {
    key: 'business.hours',
    value: { timezone: 'America/Chicago', workdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
    type: 'json',
    description: 'Operating hours used to schedule outreach (ISO weekday numbers, 24h times).',
    is_feature_flag: false,
  },
  {
    key: 'flags.demo_generation_enabled',
    value: false,
    type: 'boolean',
    description: 'Feature flag: demo generation pipeline (later brief).',
    is_feature_flag: true,
  },
  {
    key: 'flags.outreach_enabled',
    value: false,
    type: 'boolean',
    description: 'Feature flag: outreach + follow-up sending (later brief; requires EMAIL_API_KEY).',
    is_feature_flag: true,
  },
  {
    key: 'flags.production_pipeline_enabled',
    value: false,
    type: 'boolean',
    description: 'Feature flag: production website generation/deploy (later brief).',
    is_feature_flag: true,
  },
  {
    key: 'flags.billing_enabled',
    value: false,
    type: 'boolean',
    description: 'Feature flag: billing/subscriptions (later brief; platform not yet live).',
    is_feature_flag: true,
  },
  {
    key: 'integrations.enrichment.provider',
    value: 'none',
    type: 'string',
    description: 'Enrichment provider selection: "none" (default) or a future vendor id. Requires ENRICHMENT_API_KEY in env.',
    is_feature_flag: false,
  },
  {
    key: 'integrations.email.provider',
    value: 'none',
    type: 'string',
    description: 'Email provider selection: "none" (default) or a future vendor id. Requires EMAIL_API_KEY in env.',
    is_feature_flag: false,
  },
  {
    key: 'integrations.demo_hosting.provider',
    value: 'none',
    type: 'string',
    description: 'Demo hosting provider selection: "none" (default) or a future vendor id. Requires DEMO_HOSTING_API_KEY in env.',
    is_feature_flag: false,
  },
  {
    key: 'integrations.deployment.provider',
    value: 'none',
    type: 'string',
    description: 'Deployment provider selection: "none" (default) or a future vendor id. Requires DEPLOYMENT_API_KEY in env.',
    is_feature_flag: false,
  },
  {
    key: 'integrations.discovery.provider',
    value: 'none',
    type: 'string',
    description: 'Discovery provider selection: "none" (default) or a future vendor id. Requires DISCOVERY_API_KEY in env.',
    is_feature_flag: false,
  },
  {
    key: 'discovery.batch_size',
    value: 50,
    type: 'number',
    description: 'Number of provider records ingested per batch transaction during a discovery job.',
    is_feature_flag: false,
  },
  {
    key: 'discovery.max_attempts',
    value: 3,
    type: 'number',
    description: 'Maximum attempts for a discovery job (retries reuse the original target params).',
    is_feature_flag: false,
  },
  {
    key: 'discovery.schedule_interval_minutes',
    value: 0,
    type: 'number',
    description: 'Minutes between scheduled discovery runs. 0 = scheduler disabled (default).',
    is_feature_flag: false,
  },
  {
    key: 'discovery.rate_limit_per_minute',
    value: 0,
    type: 'number',
    description: 'Max provider records fetched per minute per job. 0 = unlimited (default).',
    is_feature_flag: false,
  },
];

export interface SeedSettingsOptions {
  /** Delete existing rows first (default true for tests). */
  reset?: boolean;
}

/** Serialize a JS value to a Postgres jsonb literal safely. */
export function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

export { DEFAULT_SETTINGS };

/** Idempotent seed of DEFAULT_SETTINGS (ON CONFLICT DO NOTHING). */
export async function seedSystemSettings(opts: SeedSettingsOptions = {}): Promise<void> {
  if (opts.reset !== false) {
    await db.execute(sql`DELETE FROM system_settings`);
  }
  for (const s of DEFAULT_SETTINGS) {
    await db.execute(
      sql`INSERT INTO system_settings (key, value, type, description, is_feature_flag)
          VALUES (${s.key}, ${sql.raw(sqlJson(s.value))}, ${s.type}, ${s.description}, ${s.is_feature_flag})
          ON CONFLICT (key) DO NOTHING`,
    );
  }
}