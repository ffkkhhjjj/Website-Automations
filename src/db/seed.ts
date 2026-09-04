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
import { seedSystemSettings } from './seed-settings.js';

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
  await seedSystemSettings({ reset: false }); // preserves owner edits (ON CONFLICT DO NOTHING)

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