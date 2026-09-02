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
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client';
import { users } from '../db/schema';
import { loadAuthConfig } from './config';
import { assertStrongPassword, hashPassword } from './password';
import { auditSystem } from './audit';

async function main(): Promise<void> {
  const cfg = loadAuthConfig();

  const email = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD ?? '';

  if (!email) {
    console.error('[auth:bootstrap] FAILED: OWNER_EMAIL is not set (see .env.example).');
    process.exit(1);
  }
  if (!password) {
    console.error(`[auth:bootstrap] FAILED: OWNER_PASSWORD is not set for ${email} (see .env.example).`);
    process.exit(1);
  }
  try {
    assertStrongPassword(password, cfg.minPasswordLength);
  } catch (e) {
    console.error(`[auth:bootstrap] FAILED: password for ${email} is too weak — ${(e as Error).message}`);
    process.exit(1);
  }

  const existing = await db.select().from(users).where(eq(users.email, email));
  if (existing.length > 0) {
    // Idempotent: skip. Never reset the password of an existing account.
    console.log(`[auth:bootstrap] SKIP: owner ${email} already exists (password unchanged).`);
    await auditSystem({
      action: 'auth.bootstrap.skipped',
      entityType: 'user',
      entityId: existing[0]!.id,
      metadata: { email, reason: 'owner_exists' },
    });
    await pool.end();
    return;
  }

  const passwordHash = await hashPassword(password);
  const [owner] = await db
    .insert(users)
    .values({ email, password_hash: passwordHash, role: 'OWNER' })
    .returning({ id: users.id, email: users.email, role: users.role });

  if (!owner) {
    console.error('[auth:bootstrap] FAILED: could not create owner account.');
    process.exit(1);
  }

  await auditSystem({
    action: 'auth.bootstrap.created',
    entityType: 'user',
    entityId: owner.id,
    after: { email: owner.email, role: owner.role },
  });

  console.log(`[auth:bootstrap] OK: owner account created for ${owner.email}.`);
  await pool.end();
}

main().catch((e) => {
  // Surface the error but NEVER the password.
  console.error(`[auth:bootstrap] FAILED: ${(e as Error).message}`);
  process.exit(1);
});