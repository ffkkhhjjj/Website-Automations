/**
 * Auth integration tests — run against the built Fastify app via `app.inject()`
 * (no live listener needed). They exercise the full stack: Postgres + Drizzle +
 * bcrypt + JWT + API keys + audit logging.
 *
 * DATABASE_URL is pointed at the dedicated TEST_DATABASE_URL database by
 * vitest.config.ts (env) before any test module loads; that DB is created and
 * migrated by test/global-setup.ts. The shared db client in src/db/client.ts is
 * therefore bound to the test DB for this suite.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { users, apiKeys, auditLogs, userSessions } from '../src/db/schema';
import { buildAuthApp } from '../src/auth/client';
import { hashPassword } from '../src/auth/password';

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

beforeAll(async () => {
  // Seed an owner directly (the env-driven bootstrap path is exercised by the
  // bootstrap CLI itself; here we need a known owner for the HTTP tests).
  ctx.ownerEmail = `owner-${Date.now()}@test.local`;
  ctx.ownerPassword = 'sTr0ng-P@ssw0rd-42!';
  const hash = await hashPassword(ctx.ownerPassword);
  const [owner] = await db
    .insert(users)
    .values({ email: ctx.ownerEmail, password_hash: hash, role: 'OWNER' })
    .returning({ id: users.id });
  ctx.ownerId = owner!.id;

  ctx.app = await buildAuthApp();
});

afterAll(async () => {
  if (ctx.app) await ctx.app.close();
  // Cleanup so the suite is re-runnable against the same DB:
  await db.delete(auditLogs).where(eq(auditLogs.source, 'auth'));
  await db.delete(apiKeys);
  await db.delete(users).where(eq(users.email, ctx.ownerEmail)); // cascades sessions
  await pool.end();
});

describe('owner login', () => {
  it('(1) logs in with correct password → access + refresh token', async () => {
    const res = await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.user.email).toBe(ctx.ownerEmail);
    expect(body.user.role).toBe('OWNER');
    // session row persisted with a hash (never the raw token)
    const [session] = await db.select().from(userSessions).where(eq(userSessions.user_id, ctx.ownerId));
    expect(session).toBeTruthy();
    expect(session!.refresh_token_hash).not.toBe(body.refresh_token);
    expect(session!.refresh_token_hash).toHaveLength(64);
  });

  it('(2) wrong password → 401', async () => {
    const wrong = 'wrong-password!';
    const res = await post('/auth/login', { email: ctx.ownerEmail, password: wrong });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('invalid_credentials');
    // Never leaks the submitted password value or any internal detail.
    expect(JSON.stringify(body)).not.toContain(wrong);
    expect(JSON.stringify(body)).not.toContain(ctx.ownerPassword);
  });
});

describe('unauthenticated + scopes', () => {
  it('(3) unauthenticated request → 401', async () => {
    const res = await get('/auth/me');
    expect(res.statusCode).toBe(401);
  });

  it('(4) API key with insufficient scope → 403', async () => {
    const login = await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
    expect(login.statusCode).toBe(200);
    const access = login.json().access_token as string;

    // owner creates an admin key
    const adminKeyCreate = await post(
      '/auth/keys',
      { name: `admin-${Date.now()}`, scope: 'admin' },
      { authorization: `Bearer ${access}` },
    );
    expect(adminKeyCreate.statusCode).toBe(201);
    const adminKey = adminKeyCreate.json().api_key as string;

    // admin key creates a read-scoped key
    const readKeyCreate = await post(
      '/auth/keys',
      { name: `read-${Date.now()}`, scope: 'read' },
      { authorization: `Bearer ${adminKey}` },
    );
    expect(readKeyCreate.statusCode).toBe(201);
    const readKey = readKeyCreate.json().api_key as string;

    // read-scoped key is denied on the admin-only route
    const denied = await post('/auth/keys', { name: 'nope', scope: 'read' }, { authorization: `Bearer ${readKey}` });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('insufficient_scope');
  });

  it('(5) API key with sufficient scope succeeds', async () => {
    const login = await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
    const access = login.json().access_token as string;
    const created = await post(
      '/auth/keys',
      { name: `admin2-${Date.now()}`, scope: 'admin' },
      { authorization: `Bearer ${access}` },
    );
    expect(created.statusCode).toBe(201);
    const adminKey = created.json().api_key as string;

    const ok = await post('/auth/keys', { name: `sub-${Date.now()}`, scope: 'read' }, { authorization: `Bearer ${adminKey}` });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().api_key).toBeTruthy();
  });
});

describe('auth/me and refresh rotation', () => {
  it('GET /auth/me works with a JWT and returns the owner', async () => {
    const login = await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
    const access = login.json().access_token as string;
    const me = await get('/auth/me', { authorization: `Bearer ${access}` });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(ctx.ownerEmail);
  });

  it('refresh rotates the session: old token rejected, new one valid', async () => {
    const login = await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
    const rt1 = login.json().refresh_token as string;
    const refresh1 = await post('/auth/refresh', { refresh_token: rt1 });
    expect(refresh1.statusCode).toBe(200);
    const rt2 = refresh1.json().refresh_token as string;
    expect(rt2).not.toBe(rt1);
    // old token must now be rejected (rotation)
    const replay = await post('/auth/refresh', { refresh_token: rt1 });
    expect(replay.statusCode).toBe(401);
    // new token works; access token issued alongside
    const refresh2 = await post('/auth/refresh', { refresh_token: rt2 });
    expect(refresh2.statusCode).toBe(200);
    expect(refresh2.json().access_token).toBeTruthy();
    // never return the same session twice
    expect(refresh2.json().refresh_token).not.toBe(rt2);
  });

  it('logout revokes the session — refresh thereafter fails', async () => {
    const login = await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
    const rt = login.json().refresh_token as string;
    const out = await post('/auth/logout', { refresh_token: rt });
    expect(out.statusCode).toBe(204);
    const replay = await post('/auth/refresh', { refresh_token: rt });
    expect(replay.statusCode).toBe(401);
  });
});

describe('audit logging', () => {
  it('auth events land in audit_logs with source=auth', async () => {
    await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.source, 'auth'), eq(auditLogs.action, 'auth.login.success')))
      .limit(5);
    const found = rows.find((r) => r.entity_id === ctx.ownerId);
    expect(found).toBeTruthy();
    expect(found!.actor_type).toBe('USER');
    expect(found!.actor_id).toBe(ctx.ownerId);
    expect(found!.after).toEqual(expect.objectContaining({ email: ctx.ownerEmail }));
  });
});