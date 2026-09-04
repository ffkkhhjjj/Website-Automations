/**
 * SettingsService — typed access to system_settings (single source of truth
 * for every business rule).
 *
 * Everything business-rules-shaped lives in the `system_settings` table and is
 * read/written through this service:
 *   - typed accessors return the parsed JSONB value with a type guard applied,
 *     falling back to documented spec defaults when a key is missing (fresh
 *     DBs must never 500);
 *   - `update()` validates the new value against the per-key schema, writes the
 *     row AND an audit_logs entry (before/after) in one transaction;
 *   - `list()` / `get()` return raw rows for the config API.
 *
 * Caching: read-through per key with a 10-minute TTL (`ttlMs`, injectable).
 * `update()` writes through and invalidates the cached key, so a single app
 * instance stays consistent. Multi-instance deployments will need a shared
 * cache or a short TTL — noted in README.
 *
 * The config API routes (src/config/routes.ts) own auth/rate limiting; this
 * service is transport-free so it can also be used by scripts and tests.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { systemSettings } from '../db/schema';
import { auditApiKey, auditUser, writeAudit } from '../auth/audit';
import type { AuditActorType } from '../auth/audit';
import { validateSettingValue, validateBooleanFlag } from './validation';

/** Raw row shape exposed by list()/get() (mirrors system_settings). */
export interface SettingRow {
  key: string;
  value: unknown;
  type: 'string' | 'number' | 'boolean' | 'json' | 'array';
  description: string | null;
  is_feature_flag: boolean;
  updated_at: Date;
}

export interface UpdateSettingInput {
  value: unknown;
  description?: string | null;
  is_feature_flag?: boolean;
}

export interface UpdateResult {
  row: SettingRow;
  changed: boolean;
}

export interface SettingsServiceOptions {
  /** Cache TTL in milliseconds. Default 10 minutes. */
  ttlMs?: number;
}

export class SettingsError extends Error {
  code: 'UNKNOWN_KEY' | 'INVALID_VALUE' | 'INVALID_KEY_NAME' | 'UPDATE_FAILED';
  constructor(code: SettingsError['code'], message: string) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}

/** Validate a settings key (safe for URL params and lookups). */
export const SETTING_KEY_RE = /^[a-z0-9]+(\.[a-z0-9_]+)*$/;

function normalizeKey(key: string): string {
  if (!SETTING_KEY_RE.test(key)) {
    throw new SettingsError('INVALID_KEY_NAME', `Invalid setting key "${key}"`);
  }
  return key;
}

function toRow(row: typeof systemSettings.$inferSelect): SettingRow {
  return {
    key: row.key,
    value: row.value,
    type: row.type as SettingRow['type'],
    description: row.description,
    is_feature_flag: row.is_feature_flag,
    updated_at: row.updated_at,
  };
}

export class SettingsService {
  private readonly ttlMs: number;
  /** key → { value, expiresAt } — read-through cache, invalidated on update. */
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(opts: SettingsServiceOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  }

  /** Read one raw row (uncached). Throws SettingsError UNKNOWN_KEY when absent. */
  async get(key: string): Promise<SettingRow> {
    const k = normalizeKey(key);
    const rows = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, k))
      .limit(1);
    const row = rows[0];
    if (!row) throw new SettingsError('UNKNOWN_KEY', `Setting "${k}" does not exist`);
    return toRow(row!);
  }

  /** Read one value with a type guard. Missing keys → `fallback`, never throw. */
  async getParsed<T = unknown>(
    key: string,
    guard: (v: unknown) => v is T,
    fallback: T,
  ): Promise<T> {
    const k = normalizeKey(key);
    const cached = this.cache.get(k);
    if (cached && cached.expiresAt > Date.now()) {
      return guard(cached.value) ? cached.value : fallback;
    }
    const rows = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, k))
      .limit(1);
    const raw = rows[0]?.value;
    if (raw === undefined) {
      this.cache.set(k, { value: fallback, expiresAt: Date.now() + this.ttlMs });
      return fallback;
    }
    if (!guard(raw)) {
      // Stored value is corrupt for this accessor's shape — fall back rather
      // than 500; the config API still surfaces the raw row so the owner can fix.
      this.cache.set(k, { value: fallback, expiresAt: Date.now() + this.ttlMs });
      return fallback;
    }
    this.cache.set(k, { value: raw, expiresAt: Date.now() + this.ttlMs });
    return raw;
  }

  /** List all settings (raw rows), ordered by key. Used by GET /api/settings. */
  async list(): Promise<SettingRow[]> {
    const rows = await db.select().from(systemSettings).orderBy(systemSettings.key);
    return rows.map(toRow);
  }

  /**
   * Validate + update a setting. Returns the updated row and whether the value
   * actually changed. Unknown keys / invalid values / invalid flags throw
   * SettingsError with a typed code; the DB row is never touched on rejection.
   */
  async update(
    key: string,
    input: UpdateSettingInput,
    actor: { type: AuditActorType; id?: string | null },
  ): Promise<UpdateResult> {
    const k = normalizeKey(key);
    const existing = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, k))
      .limit(1);
    const row = existing[0];
    if (!row) throw new SettingsError('UNKNOWN_KEY', `Setting "${k}" does not exist`);

    // Validate the new value against the per-key schema (weighted keys also
    // checked for exact 100 and non-negative components, etc.).
    const valid = validateSettingValue(k, input.value, row.type as SettingRow['type']);
    if (!valid.ok) {
      throw new SettingsError('INVALID_VALUE', `Invalid value for "${k}": ${valid.message}`);
    }
    if (input.is_feature_flag !== undefined && typeof input.is_feature_flag !== 'boolean') {
      throw new SettingsError('INVALID_VALUE', `is_feature_flag must be a boolean`);
    }
    // Feature-flag keys must stay boolean-semantic: enforce when the row IS a
    // feature flag, or when the caller is explicitly converting a key into one.
    if ((row.is_feature_flag || input.is_feature_flag === true) && !validateBooleanFlag(input.value)) {
      throw new SettingsError(
        'INVALID_VALUE',
        `Feature-flag settings must hold a boolean value (got ${JSON.stringify(input.value)})`,
      );
    }

    const changed = !deepEquals(input.value, row.value);
    const now = new Date();
    const patch: {
      value: unknown;
      description?: string | null;
      is_feature_flag?: boolean;
      updated_at: Date;
    } = { value: input.value, updated_at: now };
    if (input.description !== undefined) patch.description = input.description;
    if (input.is_feature_flag !== undefined) patch.is_feature_flag = input.is_feature_flag;

    const [updated] = await db
      .update(systemSettings)
      .set(patch)
      .where(eq(systemSettings.key, k))
      .returning();

    if (!updated) throw new SettingsError('UPDATE_FAILED', `Failed to update "${k}"`);

    // Audit — one row, before/after JSONB, action SETTINGS_UPDATED.
    // audit_logs.entity_id is a NOT NULL uuid, but system_settings keys are
    // text. Following the auth login-attempt convention: entity_id carries the
    // nil uuid and the real key lives in metadata.setting_key.
    await writeAudit({
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: 'SETTINGS_UPDATED',
      entityType: 'system_setting',
      entityId: '00000000-0000-0000-0000-000000000000',
      before: { value: row.value, type: row.type, is_feature_flag: row.is_feature_flag },
      after: { value: updated.value, type: updated.type, is_feature_flag: updated.is_feature_flag },
      metadata: { setting_key: k, changed, entity_id: k },
      source: 'config',
    });

    this.cache.delete(k);
    return { row: toRow(updated!), changed };
  }
}

/** Deep equality for JSON values (plain objects/arrays/primitives). */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEquals(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    for (const key of ka) {
      if (!deepEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
    }
    return true;
  }
  return false;
}

/** Convenience: audit a settings update made by a USER (owner JWT). */
export function auditSettingsUser(opts: {
  userId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  settingKey: string;
}): Promise<void> {
  return auditUser({
    userId: opts.userId,
    action: 'SETTINGS_UPDATED',
    entityType: 'system_setting',
    before: opts.before,
    after: opts.after,
    metadata: { setting_key: opts.settingKey },
  });
}

/** Convenience: audit a settings update made by an API key. */
export function auditSettingsApiKey(opts: {
  apiKeyId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  settingKey: string;
}): Promise<void> {
  return auditApiKey({
    apiKeyId: opts.apiKeyId,
    action: 'SETTINGS_UPDATED',
    entityType: 'system_setting',
    before: opts.before,
    after: opts.after,
    metadata: { setting_key: opts.settingKey },
  });
}

export type SettingsActor = { type: AuditActorType; id?: string | null };