/**
 * Configuration API + SettingsService tests — run against the built Fastify
 * app via `app.inject()` (no live listener). Exercises the full stack:
 * Postgres + Drizzle + typed SettingsService + auth scope guards + audit.
 *
 * DATABASE_URL is pointed at the dedicated TEST_DATABASE_URL database by
 * vitest.config.ts before any test loads (created + migrated by global-setup).
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { users, apiKeys, auditLogs, systemSettings } from '../src/db/schema';
import { buildAuthApp } from '../src/auth/client';
import { hashPassword } from '../src/auth/password';
import { registerConfigRoutes } from '../src/config/routes';
import { SettingsService, SettingsError } from '../src/config/service';
import { createSettingsAccessors } from '../src/config/accessors';
import { seedSystemSettings } from '../src/db/seed-settings';

interface TestCtx {
  app: Awaited<ReturnType<typeof buildAuthApp>>;
  ownerId: string;
  ownerEmail: string;
  ownerPassword: string;
}

const ctx: TestCtx = { app: null as never, ownerId: '', ownerEmail: '', ownerPassword: '' };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: path,
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function get(path: string, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: 'GET', url: path, headers });
}
function put(path: string, body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'PUT',
    url: path,
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function loginAccess(): Promise<string> {
  const res = await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
  expect(res.statusCode).toBe(200);
  return res.json().access_token as string;
}

/** Create an API key via the owner JWT; returns the raw key. */
async function createKey(name: string, scope: 'read' | 'admin'): Promise<string> {
  const access = await loginAccess();
  const res = await post('/auth/keys', { name, scope }, { authorization: `Bearer ${access}` });
  expect(res.statusCode).toBe(201);
  return res.json().api_key as string;
}

/** Optionally restore a setting to a known value between assertions. */
async function setRaw(key: string, value: unknown): Promise<void> {
  await db.update(systemSettings).set({ value }).where(eq(systemSettings.key, key));
}

beforeAll(async () => {
  // Fresh throwaway DB is created + migrated by global-setup; seed settings so
  // GET /api/settings has rows (the DB check constraint allows these types).
  await seedSystemSettings();

  ctx.ownerEmail = `config-owner-${Date.now()}@test.local`;
  ctx.ownerPassword = 'sTr0ng-P@ssw0rd-42!';
  const hash = await hashPassword(ctx.ownerPassword);
  const [owner] = await db
    .insert(users)
    .values({ email: ctx.ownerEmail, password_hash: hash, role: 'OWNER' })
    .returning({ id: users.id });
  ctx.ownerId = owner!.id;

  ctx.app = await buildAuthApp({ registerRateLimit: false });
  await registerConfigRoutes(ctx.app, { registerRateLimit: false });
});

afterAll(async () => {
  if (ctx.app) await ctx.app.close();
  await db.delete(auditLogs).where(eq(auditLogs.source, 'config'));
  await db.delete(auditLogs).where(eq(auditLogs.source, 'auth'));
  await db.delete(apiKeys);
  await db.delete(users).where(eq(users.email, ctx.ownerEmail)); // cascades sessions
  await pool.end();
});

describe('GET /api/settings', () => {
  it('(1a) owner JWT sees the seeded settings list', async () => {
    const access = await loginAccess();
    const res = await get('/api/settings', { authorization: `Bearer ${access}` });
    expect(res.statusCode).toBe(200);
    const { settings } = res.json();
    expect(Array.isArray(settings)).toBe(true);
    const keys = settings.map((s: { key: string }) => s.key);
    expect(keys).toContain('target.industries');
    expect(keys).toContain('scoring.website_quality.weights');
    expect(keys).toContain('pricing.website_setup_fee_cents');
    const plumb = settings.find((s: { key: string }) => s.key === 'target.industries');
    expect(plumb).toBeTruthy();
    expect(plumb.value).toEqual(['plumbing']);
    expect(typeof plumb.is_feature_flag).toBe('boolean');
    expect(plumb.updated_at).toBeTruthy();
  });

  it('(1b) 401 without auth', async () => {
    const res = await get('/api/settings');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_credentials');
  });
});

describe('PUT /api/settings', () => {
  it('(2) owner updates a setting; value + updated_at change and audit row written', async () => {
    const access = await loginAccess();
    await setRaw('target.states', []);
    const before = await get('/api/settings', { authorization: `Bearer ${access}` });
    const rowBefore = before
      .json()
      .settings.find((s: { key: string }) => s.key === 'target.states');

    const res = await put(
      '/api/settings/target.states',
      { value: ['TX', 'FL'] },
      { authorization: `Bearer ${access}` },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().setting.value).toEqual(['TX', 'FL']);
    expect(res.json().setting.key).toBe('target.states');
    // updated_at bumped
    const rowAfter = res.json().setting;
    expect(new Date(rowAfter.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(rowBefore!.updated_at).getTime(),
    );

    // audit row: SETTINGS_UPDATED, before/after JSONB, actor = owner
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'SETTINGS_UPDATED'), eq(auditLogs.source, 'config')));
    const found = rows.find((r) => r.metadata?.setting_key === 'target.states');
    expect(found).toBeTruthy();
    expect(found!.actor_type).toBe('USER');
    expect(found!.actor_id).toBe(ctx.ownerId);
    expect(found!.before).toEqual({ value: [], type: 'array', is_feature_flag: false });
    expect(found!.after).toEqual({ value: ['TX', 'FL'], type: 'array', is_feature_flag: false });

    // restore for later assertions
    await setRaw('target.states', []);
  });

  it('(3) invalid value rejected with typed error; row unchanged', async () => {
    const access = await loginAccess();
    const before = await get('/api/settings', { authorization: `Bearer ${access}` });
    const wsqBefore = before
      .json()
      .settings.find((s: { key: string }) => s.key === 'scoring.website_quality.weights');

    // weights that do not sum to 100 → rejected
    const res = await put(
      '/api/settings/scoring.website_quality.weights',
      { value: { conversion: 10 } },
      { authorization: `Bearer ${access}` },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_setting');
    expect(String(res.json().error.message)).toContain('sum to 100');

    // row unchanged
    const after = await get('/api/settings', { authorization: `Bearer ${access}` });
    const wsqAfter = after
      .json()
      .settings.find((s: { key: string }) => s.key === 'scoring.website_quality.weights');
    expect(wsqAfter.value).toEqual(wsqBefore!.value);
  });

  it('(4) unknown key rejected', async () => {
    const access = await loginAccess();
    const res = await put(
      '/api/settings/does.not.exist',
      { value: 1 },
      { authorization: `Bearer ${access}` },
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('invalid_setting');
    expect(String(res.json().error.message)).toContain('does not exist');
  });
});

describe('API key scopes on settings', () => {
  it('(5a) read-scope key CANNOT update (403)', async () => {
    const readKey = await createKey(`read-${Date.now()}`, 'read');
    const res = await put(
      '/api/settings/target.states',
      { value: ['CA'] },
      { authorization: `Bearer ${readKey}` },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('(5b) admin-scope key CAN update', async () => {
    const adminKey = await createKey(`admin-${Date.now()}`, 'admin');
    const res = await put(
      '/api/settings/target.states',
      { value: ['TX'] },
      { authorization: `Bearer ${adminKey}` },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().setting.value).toEqual(['TX']);

    // audit actor is API + key id
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'SETTINGS_UPDATED'), eq(auditLogs.source, 'config')));
    const found = rows[rows.length - 1]!;
    expect(found.actor_type).toBe('API');
    expect(found.metadata?.setting_key).toBe('target.states');
    await setRaw('target.states', []);
  });

  it('(5c) read-scope key CAN read (GET)', async () => {
    const readKey = await createKey(`read-g-${Date.now()}`, 'read');
    const res = await get('/api/settings', { authorization: `Bearer ${readKey}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.length).toBeGreaterThan(0);
  });
});

describe('SettingsService typed accessors', () => {
  it('(6a) accessors return parsed seeded values with types', async () => {
    const svc = new SettingsService();
    const acc = createSettingsAccessors(svc);
    const [industries, states, weights, thresholds, pricing, flags] = await Promise.all([
      acc.getTargetIndustries(),
      acc.getTargetStates(),
      acc.getScoringWeights('website_quality'),
      acc.getLeadThresholds(),
      acc.getPricing(),
      acc.getFeatureFlag('flags.outreach_enabled'),
    ]);
    expect(industries).toEqual(['plumbing']);
    expect(Array.isArray(states)).toBe(true);
    expect(weights.weights.conversion).toBe(25);
    expect(weights.sourceKey).toBe('scoring.website_quality.weights');
    expect(thresholds.high_priority_min).toBe(80);
    expect(pricing.website_setup_fee_cents).toBe(150000);
    expect(flags).toBe(false);
  });

  it('(6b) missing-key default path works (fresh DB does not 500)', async () => {
    const svc = new SettingsService();
    const acc = createSettingsAccessors(svc);
    // delete a key, then the accessor must fall back to the documented default
    await db.delete(systemSettings).where(eq(systemSettings.key, 'target.industries'));
    const industries = await acc.getTargetIndustries();
    expect(industries).toEqual(['plumbing']);

    // service.get throws typed SettingsError (surface for the API)
    await expect(svc.get('target.industries')).rejects.toBeInstanceOf(SettingsError);
    // restore
    await db.insert(systemSettings).values({
      key: 'target.industries',
      value: ['plumbing'],
      type: 'array',
      description: 'Industries the platform targets for website-sales outreach.',
      is_feature_flag: false,
    });
  });

  it('(6c) invalid stored value falls back rather than 500', async () => {
    const svc = new SettingsService();
    const acc = createSettingsAccessors(svc);
    await db
      .update(systemSettings)
      .set({ value: 'not-an-array' })
      .where(eq(systemSettings.key, 'target.states'));
    const states = await acc.getTargetStates();
    expect(states).toEqual([]);
    await setRaw('target.states', []);
  });
});