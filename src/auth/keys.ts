/**
 * Server-side API keys (service-to-service auth).
 *
 * The raw key is generated with a recognizable prefix (e.g. `lge_`), returned
 * to the caller EXACTLY once at creation, and only its SHA-256 hex hash is
 * stored in api_keys. Scopes are the enum values from the schema ('read' | 'admin').
 */
import { randomBytes, createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { apiKeys } from '../db/schema';
import type { AuthConfig } from './config';
import { AuthError, authErr } from './tokens';

export const API_KEY_BYTES = 32;

/** sha256 hex of the raw key — the only representation kept at rest. */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/** Extract the raw key (the part after the prefix) for lookup by prefix+hash. */
function keyParts(rawKey: string): { prefix: string; hash: string } {
  return {
    prefix: rawKey.slice(0, rawKey.indexOf('_')),
    hash: hashApiKey(rawKey),
  };
}

export interface ApiKeyResult {
  /** Raw key — returned exactly once, at creation. Never store or log it. */
  rawKey: string;
  id: string;
  name: string;
  scope: 'read' | 'admin';
}

/**
 * Create an API key. The raw key is returned once; only its hash is persisted.
 * `name` must be unique. `expiresAt` is optional and passed through to the row.
 */
export async function createApiKey(
  cfg: AuthConfig,
  opts: { name: string; scope: 'read' | 'admin'; allowedResources?: string | null; expiresAt?: Date | null },
): Promise<ApiKeyResult> {
  const rawKey = `${cfg.apiKeyPrefix}_${randomBytes(API_KEY_BYTES).toString('hex')}`;
  const { prefix, hash } = keyParts(rawKey);
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: opts.name,
      prefix,
      key_hash: hash,
      scope: opts.scope,
      allowed_resources: opts.allowedResources ?? null,
      expires_at: opts.expiresAt ?? null,
    })
    .returning({ id: apiKeys.id, name: apiKeys.name, scope: apiKeys.scope });
  if (!row) throw new Error('Failed to create API key');
  return { rawKey, id: row.id, name: row.name, scope: row.scope };
}

/**
 * Resolve a raw Bearer key to its api_keys row.
 * Rejects unknown keys, revoked/inactive keys, and expired keys.
 */
export async function verifyApiKey(rawKey: string): Promise<typeof apiKeys.$inferSelect> {
  const { prefix, hash } = keyParts(rawKey);
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), eq(apiKeys.key_hash, hash)));
  if (!row || !row.is_active || row.revoked_at) {
    throw authErr('invalid_api_key', 'Invalid API key');
  }
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    throw authErr('invalid_api_key', 'API key has expired');
  }
  // Best-effort touch; failure must not break the request.
  try {
    await db.update(apiKeys).set({ last_used_at: new Date() }).where(eq(apiKeys.id, row.id));
  } catch {
    // ignore
  }
  return row;
}

/** Revoke an API key by id (soft delete via is_active=false + revoked_at). */
export async function revokeApiKey(id: string): Promise<{ ok: boolean; id: string }> {
  const res = await db
    .update(apiKeys)
    .set({ is_active: false, revoked_at: new Date() })
    .where(eq(apiKeys.id, id));
  return { ok: (res.rowCount ?? 0) > 0, id };
}

export function isAuthError(e: unknown): e is AuthError {
  return e instanceof AuthError;
}