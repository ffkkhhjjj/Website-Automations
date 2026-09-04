/**
 * Owner bootstrap CLI.
 *
 * Creates the single owner account from OWNER_EMAIL + OWNER_PASSWORD env vars.
 * - Fails clearly (exit 1) if env vars are missing or the password is weak.
 * - Idempotent: if an account with that email already exists it is LEFT UNTOUCHED
 *   (skip + log) — bootstrap never overwrites an existing password.
 * - Never logs or echoes the password; never creates other roles or signup routes.
 *
 * Usage: npm run auth:bootstrap   (loads .env via dotenv)
 */
import 'dotenv/config';
import { pool } from '../db/client';
import { bootstrapOwner } from './bootstrap-owner-fn';

async function main(): Promise<void> {
  const result = await bootstrapOwner();
  if (!result.ok) {
    console.error(`[auth:bootstrap] FAILED: ${result.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
  console.log(`[auth:bootstrap] ${result.skipped ? 'SKIP' : 'OK'}: ${result.message}`);
  await pool.end();
}

main().catch((e) => {
  // Surface the error but NEVER the password.
  console.error(`[auth:bootstrap] FAILED: ${(e as Error).message}`);
  process.exit(1);
});