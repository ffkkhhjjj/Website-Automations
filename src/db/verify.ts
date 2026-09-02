/**
 * Schema verification — proves the migration + seed ran against a real Postgres.
 *
 *   npm run db:verify
 *
 * Prints PASS/FAIL for:
 *  - all 27 expected tables exist
 *  - all 28 expected enum types exist
 *  - key indexes exist (businesses by lifecycle state, messages by campaign, events by date)
 *  - FK constraints exist (contacts.business_id, lead_scores.scoring_version, ...)
 *  - score CHECK constraints exist (0-100)
 *  - seed data: system_settings count, scoring_versions v1 per type, active flags
 *  - metrics unique constraint (date, name, dimension-key) exists
 */

import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from './client.js';

// drizzle db.execute returns rows as Record<string, unknown> — row() narrows
// to the shape we query for.
type Row = Record<string, unknown>;
const row = (r: Row) => r; // identity, documents intent

const EXPECTED_TABLES = [
  'businesses', 'contacts', 'websites', 'website_analyses', 'lead_scores',
  'demos', 'outreach_campaigns', 'outreach_messages', 'followups', 'conversations',
  'conversation_messages', 'sales_opportunities', 'customers', 'customer_onboarding',
  'production_websites', 'website_versions', 'domains', 'subscriptions', 'payments',
  'tasks', 'exceptions', 'audit_logs', 'system_settings', 'scoring_versions',
  'templates', 'metrics', 'lead_state_history',
];

const EXPECTED_ENUMS = [
  'lead_lifecycle_state', 'website_status', 'website_classification',
  'lead_classification', 'demo_status', 'campaign_status', 'message_status',
  'followup_status', 'conversation_status', 'message_direction',
  'reply_classification', 'opportunity_status', 'customer_status',
  'onboarding_status', 'production_website_status', 'website_version_status',
  'domain_status', 'subscription_status', 'subscription_interval',
  'payment_status', 'task_status', 'exception_priority', 'exception_status',
  'scoring_type', 'template_type', 'business_operational_status',
  'contact_status', 'audit_actor_type',
];

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function keyNames(rows: Row[], key: string): string[] {
  return rows.map((r) => String(r[key]));
}

async function run() {
  const tables = await db.execute(sql`
    SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE 'drizzle%'
  `);
  const tableNames = new Set(keyNames(tables.rows, 'tablename'));
  for (const t of EXPECTED_TABLES) check(`table ${t}`, tableNames.has(t));
  check('extra tables beyond expected', tableNames.size === EXPECTED_TABLES.length, `${tableNames.size} total`);

  const enums = await db.execute(sql`
    SELECT typname FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
  `);
  const enumNames = new Set(keyNames(enums.rows, 'typname'));
  for (const e of EXPECTED_ENUMS) check(`enum ${e}`, enumNames.has(e));

  const indexes = await db.execute(sql`
    SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = 'public'
  `);
  const indexNames = new Set(keyNames(indexes.rows, 'indexname'));
  const requiredIndexes = [
    'idx_businesses_lifecycle_state', 'idx_businesses_state_city', 'idx_businesses_source',
    'idx_outreach_messages_campaign_id', 'idx_outreach_messages_status',
    'idx_followups_status_scheduled_at', 'idx_audit_logs_entity', 'idx_audit_logs_created_at',
    'idx_tasks_status_scheduled_at', 'idx_exceptions_status_priority',
    'idx_website_analyses_analyzed_at', 'idx_lead_scores_priority', 'idx_lead_scores_classification',
  ];
  for (const i of requiredIndexes) check(`index ${i}`, indexNames.has(i));

  const constraints = await db.execute(sql`
    SELECT conname FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
  `);
  const constraintNames = new Set(keyNames(constraints.rows, 'conname'));
  const requiredConstraints = [
    'contacts_business_id_businesses_id_fk', 'lead_scores_scoring_version_scoring_versions_id_fk',
    'website_analyses_analysis_version_scoring_versions_id_fk',
    'outreach_messages_campaign_id_outreach_campaigns_id_fk',
    'followups_outreach_message_id_outreach_messages_id_fk',
    'u_websites_url', 'u_metrics_date_name_dim', 'u_customers_business_id',
    'u_scoring_versions_type_version', 'u_website_versions_site_number',
  ];
  for (const c of requiredConstraints) check(`constraint ${c}`, constraintNames.has(c));

  for (const c of ['chk_businesses_contactability', 'chk_lead_scores_wsq', 'chk_lead_scores_bos', 'chk_lead_scores_priority']) {
    check(`check ${c}`, constraintNames.has(c));
  }

  const settings = await db.execute(sql`SELECT key, type, value FROM system_settings ORDER BY key`);
  check('system_settings seeded', settings.rows.length >= 10, `${settings.rows.length} rows`);
  const versions = await db.execute(sql`
    SELECT score_type, version, is_active, weights FROM scoring_versions ORDER BY score_type, version
  `);
  const activePerType = await db.execute(sql`
    SELECT score_type, COUNT(*)::int AS n FROM scoring_versions WHERE is_active GROUP BY score_type
  `);
  check('scoring_versions has 3 rows (1/schema, v1)', versions.rows.length === 3, `${versions.rows.length}`);
  check(
    'scoring_versions v1 all active',
    activePerType.rows.length === 3,
    `${activePerType.rows.map((r) => String(r.score_type)).join(', ')}`,
  );

  console.log('\n--- seeded system_settings ---');
  for (const r of settings.rows) {
    const v = r.value;
    console.log(`  ${String(r.key)} (${String(r.type)}) = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  console.log('\n--- seeded scoring_versions ---');
  for (const r of versions.rows) {
    console.log(`  ${String(r.score_type)} v${String(r.version)} active=${String(r.is_active)} weights=${JSON.stringify(r.weights)}`);
  }

  await pool.end();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(async (err) => {
  console.error('Verify failed with error:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});