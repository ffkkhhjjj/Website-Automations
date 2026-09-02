/**
 * Idempotent seed for default business rules.
 *
 * - system_settings: every business rule lives here; seeded rows are inserted
 *   with ON CONFLICT DO NOTHING so the owner's later edits are preserved.
 * - scoring_versions: version 1 per score_type with the master-spec weights;
 *   seeded with ON CONFLICT DO NOTHING on (score_type, version).
 *
 * Run: npm run db:seed   (requires DATABASE_URL, defaults to local lge/lge)
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from './client.js';

/** Defaults mirroring the master spec. Change via Settings, never in code. */
const DEFAULT_SETTINGS = [
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
];

/** Master-spec weights, version 1 per score type. */
const SCORING_VERSIONS = [
  {
    score_type: 'WEBSITE_QUALITY',
    version: 1,
    weights: { conversion: 25, mobile: 20, content: 15, trust: 15, technical: 15, design_ux: 10 },
    description: 'Website quality: weighted deterministic checks, 0-100.',
    is_active: true,
  },
  {
    score_type: 'BUSINESS_OPPORTUNITY',
    version: 1,
    weights: { viability: 25, demand: 25, ability_to_pay: 20, contactability: 20, icp_fit: 10 },
    description: 'Business opportunity: configurable category weights, 0-100.',
    is_active: true,
  },
  {
    score_type: 'LEAD_PRIORITY',
    version: 1,
    weights: { website_quality: 0.45, business_opportunity: 0.4, market_fit: 0.15 },
    description: 'Lead priority = (100-wsq)*0.45 + bos*0.40 + market_fit*0.15, 0-100.',
    is_active: true,
  },
];

async function seed() {
  console.log('Seeding system_settings...');
  for (const s of DEFAULT_SETTINGS) {
    await db.execute(
      sql`INSERT INTO system_settings (key, value, type, description, is_feature_flag)
          VALUES (${s.key}, ${sql.raw(sqlJson(s.value))}, ${s.type}, ${s.description}, ${s.is_feature_flag})
          ON CONFLICT (key) DO NOTHING`,
    );
  }

  console.log('Seeding scoring_versions...');
  for (const v of SCORING_VERSIONS) {
    await db.execute(
      sql`INSERT INTO scoring_versions (score_type, version, weights, description, is_active)
          VALUES (${v.score_type}, ${v.version}, ${sql.raw(sqlJson(v.weights))}, ${v.description}, ${v.is_active})
          ON CONFLICT (score_type, version) DO NOTHING`,
    );
  }

  const settingsCount = await db.execute(sql`SELECT COUNT(*)::int AS n FROM system_settings`);
  const versionsCount = await db.execute(sql`SELECT COUNT(*)::int AS n FROM scoring_versions`);
  console.log(
    `Done. system_settings=${settingsCount.rows[0]?.n} scoring_versions=${versionsCount.rows[0]?.n}`,
  );
  await pool.end();
}

/** Serialize a JS value to a Postgres jsonb literal safely. */
function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

seed().catch(async (err) => {
  console.error('Seed failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});