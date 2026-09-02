/**
 * Global test setup (vitest globalSetup) — runs once before the whole suite.
 *
 * Creates a dedicated throwaway Postgres database for auth tests so the shared
 * `lge` dev DB is never polluted. Requires a reachable Postgres; the connection
 * params come from env (TEST_DATABASE_URL) and default to the sandbox-local
 * Postgres (lge/lge/lge on 127.0.0.1:5432), which matches docker-compose.
 *
 * Migration files are applied directly with the pg driver (drizzle migrations
 * runner would need an extra dependency; the SQL files are self-contained).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
const { Client, Pool } = pg;

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://lge:lge@127.0.0.1:5432/lge';
const TEST_DB = process.env.TEST_DB_NAME ?? 'lge_auth_test';
const TEST_URL = process.env.TEST_DATABASE_URL ?? `postgres://lge:lge@127.0.0.1:5432/${TEST_DB}`;

export async function setup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // Fresh DB every run (idempotent): drop any leftover test DB, then recreate.
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`) // PG13+ — identifier, not user input
    .catch((e) => {
      // WITH (FORCE) may fail on old PG; without force, reconnect-disconnect first.
      const err = e as { code?: string };
      if (err.code === '42601') {
        return admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      }
      throw e;
    });
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testPool = new Pool({ connectionString: TEST_URL, max: 1 });
  const migrationsDir = join(process.cwd(), 'drizzle');
  const files = readdirSync(migrationsDir)
    .filter((f) => /^000[0-9]_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    await testPool.query(sql);
  }
  await testPool.end();
}

export async function teardown(): Promise<void> {
  // DB is dropped on the next setup; nothing to do here.
}

export { TEST_URL };