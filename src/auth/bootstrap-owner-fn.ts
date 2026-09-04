/**
 * Idempotent owner bootstrap as a callable function — used by the app server
 * start path (src/index.ts) and by the CLI below. Never overwrites an existing
 * owner's password; never logs or echoes a password.
 *
 * `ok: false` means the env configuration is missing/invalid — a hard start
 * failure. `skipped: true` means an owner already exists (password untouched).
 */
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client';
import { users } from '../db/schema';
import { loadAuthConfig } from './config';
import { assertStrongPassword, hashPassword } from './password';
import { auditSystem } from './audit';

export interface BootstrapResult {
  ok: boolean;
  skipped?: boolean;
  message: string;
}

export async function bootstrapOwner(): Promise<BootstrapResult> {
  const cfg = loadAuthConfig();

  const email = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD ?? '';

  if (!email) {
    return { ok: false, message: 'OWNER_EMAIL is not set (see .env.example)' };
  }
  if (!password) {
    return { ok: false, message: `OWNER_PASSWORD is not set for ${email} (see .env.example)` };
  }
  try {
    assertStrongPassword(password, cfg.minPasswordLength);
  } catch (e) {
    return { ok: false, message: `password for ${email} is too weak — ${(e as Error).message}` };
  }

  const existing = await db.select().from(users).where(eq(users.email, email));
  if (existing.length > 0) {
    await auditSystem({
      action: 'auth.bootstrap.skipped',
      entityType: 'user',
      entityId: existing[0]!.id,
      metadata: { email, reason: 'owner_exists' },
    });
    return { ok: true, skipped: true, message: `owner ${email} already exists (password unchanged)` };
  }

  const passwordHash = await hashPassword(password);
  const [owner] = await db
    .insert(users)
    .values({ email, password_hash: passwordHash, role: 'OWNER' })
    .returning({ id: users.id, email: users.email, role: users.role });

  if (!owner) {
    return { ok: false, message: 'could not create owner account' };
  }

  await auditSystem({
    action: 'auth.bootstrap.created',
    entityType: 'user',
    entityId: owner.id,
    after: { email: owner.email, role: owner.role },
  });

  return { ok: true, skipped: false, message: `owner account created for ${owner.email}` };
}