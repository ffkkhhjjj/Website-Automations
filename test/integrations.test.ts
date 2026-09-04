/**
 * Integrations tests — registry honesty + status endpoint auth, run against the
 * built Fastify app via `app.inject()`.
 *
 * Covers (brief 7):
 *  - no env vars → every module reports configured:false, requiresConfiguration
 *    true, and the exact documented missingEnvVars;
 *  - NotConfiguredProvider methods THROW a clear "requires configuration" error
 *    (no fake success anywhere);
 *  - a test-only concrete stub provider (registered via the test hook) satisfies
 *    the interface, and a registry reports configured:true ONLY when the
 *    provider is selected in system_settings AND its env credential is present;
 *  - GET /api/integrations/status: 401 unauthenticated, honest payload when
 *    authenticated with owner JWT or a read-scope API key.
 *
 * DATABASE_URL is pointed at the dedicated TEST_DATABASE_URL database by
 * vitest.config.ts before any test module loads (see test/global-setup.ts).
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { users, apiKeys, auditLogs } from '../src/db/schema';
import { buildAuthApp } from '../src/auth/client';
import { hashPassword } from '../src/auth/password';
import { seedSystemSettings } from '../src/db/seed-settings';
import { settingsService } from '../src/config/singleton';
import { registerIntegrationsRoutes, INTEGRATIONS_STATUS_ROUTE } from '../src/integrations/routes';
import { IntegrationRegistry, NotConfiguredError } from '../src/integrations/registry';
import { createTestRegistry } from '../src/integrations/test-hooks';
import {
  INTEGRATION_PROVIDER_NONE,
  MODULE_ENV_VARS,
  type EmailProvider,
  type IntegrationModuleId,
  type ModuleStatus,
} from '../src/integrations/types';

/** All registry modules in canonical order. */
const ALL_MODULES = ['enrichment', 'email', 'demo_hosting', 'deployment'] as const;

interface TestCtx {
  app: Awaited<ReturnType<typeof buildAuthApp>>;
  ownerId: string;
  ownerEmail: string;
  ownerPassword: string;
}

const ctx: TestCtx = { app: null as never, ownerId: '', ownerEmail: '', ownerPassword: '' };

function get(path: string, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: 'GET', url: path, headers });
}
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
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

async function createReadKey(): Promise<string> {
  const access = await loginAccess();
  const res = await post('/auth/keys', { name: `int-read-${Date.now()}`, scope: 'read' }, { authorization: `Bearer ${access}` });
  expect(res.statusCode).toBe(201);
  return res.json().api_key as string;
}

/** Field-level shape of one registry status entry. */
function expectModuleStatusShape(s: ModuleStatus, module: IntegrationModuleId) {
  expect(s.module).toBe(module);
  expect(typeof s.provider).toBe('string');
  expect(typeof s.configured).toBe('boolean');
  expect(typeof s.requiresConfiguration).toBe('boolean');
  expect(Array.isArray(s.missingEnvVars)).toBe(true);
}

/** A concrete, README-representative stub email provider for tests. */
function makeStubEmailProvider(name: string): EmailProvider {
  return {
    name,
    async send(message) {
      return { ok: true, status: 'SENT', messageId: `test-${name}-${message.to}` };
    },
  };
}

/** Set + restore an env var around a callback. */
async function withEnvVar(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (saved !== undefined) process.env[name] = saved;
    else delete process.env[name];
  }
}

/** Set + restore a settings value around a callback. */
async function withSetting(
  key: string,
  value: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const before = (await settingsService.get(key).catch(() => null))?.value;
  await settingsService.update(key, { value }, { type: 'SYSTEM' });
  try {
    await fn();
  } finally {
    if (before === undefined) {
      await settingsService.update(key, { value: INTEGRATION_PROVIDER_NONE }, { type: 'SYSTEM' }).catch(() => undefined);
    } else {
      await settingsService.update(key, { value: before }, { type: 'SYSTEM' }).catch(() => undefined);
    }
  }
}

beforeAll(async () => {
  // Fresh throwaway DB is created + migrated by global-setup; seed settings so
  // the integration provider-selection reads have rows (values default to none).
  await seedSystemSettings();

  ctx.ownerEmail = `int-owner-${Date.now()}@test.local`;
  ctx.ownerPassword = 'sTr0ng-P@ssw0rd-42!';
  const hash = await hashPassword(ctx.ownerPassword);
  const [owner] = await db
    .insert(users)
    .values({ email: ctx.ownerEmail, password_hash: hash, role: 'OWNER' })
    .returning({ id: users.id });
  ctx.ownerId = owner!.id;

  ctx.app = await buildAuthApp({ registerRateLimit: false });
  await registerIntegrationsRoutes(ctx.app, { registerRateLimit: false });
});

afterAll(async () => {
  if (ctx.app) await ctx.app.close();
  await db.delete(auditLogs).where(eq(auditLogs.source, 'auth'));
  await db.delete(apiKeys);
  await db.delete(users).where(eq(users.email, ctx.ownerEmail)); // cascades sessions
  await pool.end();
});

describe('registry honesty with no env credentials', () => {
  it('(1a) all modules: configured=false, requiresConfiguration=true, documented missingEnvVars', async () => {
    const registry = new IntegrationRegistry();
    for (const module of ALL_MODULES) {
      const s = await registry.status(module);
      expectModuleStatusShape(s, module);
      expect(s.provider).toBe(INTEGRATION_PROVIDER_NONE);
      expect(s.configured).toBe(false);
      expect(s.requiresConfiguration).toBe(true);
      expect(s.missingEnvVars).toEqual([...MODULE_ENV_VARS[module]]);
    }
  });

  it('(1b) statusAll() returns all four modules in canonical order', async () => {
    const registry = new IntegrationRegistry();
    const all = await registry.statusAll();
    expect(all.map((m) => m.module)).toEqual([...ALL_MODULES]);
    for (const s of all) {
      expectModuleStatusShape(s, s.module);
      expect(s.configured).toBe(false);
      expect(s.requiresConfiguration).toBe(true);
    }
  });

  it('(1c) every NotConfiguredProvider method throws a clear error (no fake success)', async () => {
    const registry = new IntegrationRegistry();

    await expect(registry.get('enrichment').enrich({ businessName: 'Acme Plumbing' })).rejects.toThrow('requires configuration');
    await expect(registry.get('email').send({
      from: 'x@y.z', to: 'a@b.c', subject: 's', textBody: 'b',
    })).rejects.toThrow('requires configuration');
    await expect(registry.get('demo_hosting').publishDemo({ slug: 'acme', files: { 'index.html': '<h1>hi</h1>' } })).rejects.toThrow('requires configuration');
    await expect(registry.get('deployment').deploy({ siteKey: 'acme', files: { 'index.html': '<h1>hi</h1>' } })).rejects.toThrow('requires configuration');
    await expect(registry.get('demo_hosting').recordView('https://demo.example')).rejects.toThrow('requires configuration');

    // The error is the documented, machine-checkable type with the env list.
    const err = await registry.get('email').send({
      from: 'x@y.z', to: 'a@b.c', subject: 's', textBody: 'b',
    }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : null),
    );
    expect(err).toBeInstanceOf(NotConfiguredError);
    expect((err as NotConfiguredError).message).toContain('integration "email" requires configuration: EMAIL_API_KEY');
  });
});

describe('test-only concrete stub provider via the test hook', () => {
  it('(2a) stub satisfies the interface and works through the registry', async () => {
    const registry = createTestRegistry({ email: makeStubEmailProvider('stub-acme') });
    const res = await registry.get('email').send({
      from: 'me@lge.local', to: 'biz@example.com', subject: 'Hi', textBody: 'Demo ready',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('SENT');
    expect(res.messageId).toBe('test-stub-acme-biz@example.com');
  });

  it('(2b) a registered stub alone is never configured (selection + env both required)', async () => {
    const registry = createTestRegistry({ email: makeStubEmailProvider('stub-betty') });
    const s = await registry.status('email');
    expect(s.provider).toBe(INTEGRATION_PROVIDER_NONE); // not selected in settings
    expect(s.configured).toBe(false);
    expect(s.requiresConfiguration).toBe(true);
    expect(s.missingEnvVars).toEqual(['EMAIL_API_KEY']);
    // Env present but provider not selected → still not configured.
    await withEnvVar('EMAIL_API_KEY', 'test-key', async () => {
      const s2 = await registry.status('email');
      expect(s2.configured).toBe(false);
      expect(s2.requiresConfiguration).toBe(true);
      expect(s2.missingEnvVars).toEqual(['EMAIL_API_KEY']);
    });
  });

  it('(2c) provider selected in settings + env present → configured:true; others stay honest', async () => {
    const registry = createTestRegistry({ email: makeStubEmailProvider('stub-carol') });
    await withSetting('integrations.email.provider', 'stub-carol', async () => {
      await withEnvVar('EMAIL_API_KEY', 'test-key', async () => {
        const s = await registry.status('email');
        expect(s.provider).toBe('stub-carol');
        expect(s.configured).toBe(true);
        expect(s.requiresConfiguration).toBe(false);
        expect(s.missingEnvVars).toEqual([]);
      });
      // Without the credential the SAME selection is honestly unconfigured.
      const s = await registry.status('email');
      expect(s.configured).toBe(false);
      expect(s.requiresConfiguration).toBe(true);
      expect(s.missingEnvVars).toEqual(['EMAIL_API_KEY']);
    });
    // Every other module stays not-configured regardless.
    expect((await registry.status('enrichment')).configured).toBe(false);
    expect((await registry.status('demo_hosting')).configured).toBe(false);
    expect((await registry.status('deployment')).configured).toBe(false);
  });

  it('(2d) an env credential alone (no provider selected) never marks a module configured', async () => {
    const registry = new IntegrationRegistry();
    await withEnvVar('DEMO_HOSTING_API_KEY', 'test-key', async () => {
      const s = await registry.status('demo_hosting');
      expect(s.provider).toBe(INTEGRATION_PROVIDER_NONE); // no provider selected
      expect(s.configured).toBe(false); // env alone is never enough
      expect(s.requiresConfiguration).toBe(true);
      expect(s.missingEnvVars).toEqual(['DEMO_HOSTING_API_KEY']);
    });
  });
});

describe('GET /api/integrations/status', () => {
  it('(3a) 401 without credentials', async () => {
    const res = await get(INTEGRATIONS_STATUS_ROUTE);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_credentials');
  });

  it('(3b) honest payload with owner JWT: all modules, correct shape', async () => {
    const access = await loginAccess();
    const res = await get(INTEGRATIONS_STATUS_ROUTE, { authorization: `Bearer ${access}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.generatedAt).toBe('string');
    const modules = body.modules as ModuleStatus[];
    expect(modules.map((m) => m.module)).toEqual([...ALL_MODULES]);
    for (const m of modules) {
      expectModuleStatusShape(m, m.module);
      expect(m.configured).toBe(false);
      expect(m.requiresConfiguration).toBe(true);
      expect(m.missingEnvVars.length).toBeGreaterThan(0);
    }
  });

  it('(3c) works with a read-scope API key', async () => {
    const key = await createReadKey();
    const res = await get(INTEGRATIONS_STATUS_ROUTE, { authorization: `Bearer ${key}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().modules.length).toBe(4);
  });

  it('(3d) payload reflects a settings-applied provider selection + env presence', async () => {
    // Point the email module at a (test-only) registered provider and set the
    // matching env credential: the endpoint (built with that registry) then
    // reports configured:true for email only.
    const registry = createTestRegistry({ email: makeStubEmailProvider('stub-http') });
    const app2 = await buildAuthApp({ registerRateLimit: false });
    await registerIntegrationsRoutes(app2, { registry });
    try {
      const access = await loginAccess();
      await withSetting('integrations.email.provider', 'stub-http', async () => {
        await withEnvVar('EMAIL_API_KEY', 'test-key', async () => {
          const res = await app2.inject({
            method: 'GET',
            url: INTEGRATIONS_STATUS_ROUTE,
            headers: { authorization: `Bearer ${access}` },
          });
          expect(res.statusCode).toBe(200);
          const modules = res.json().modules as ModuleStatus[];
          const email = modules.find((m) => m.module === 'email')!;
          expect(email.provider).toBe('stub-http');
          expect(email.configured).toBe(true);
          expect(email.requiresConfiguration).toBe(false);
          expect(email.missingEnvVars).toEqual([]);
          for (const m of modules.filter((m) => m.module !== 'email')) {
            expect(m.configured).toBe(false);
            expect(m.requiresConfiguration).toBe(true);
          }
        });
      });
    } finally {
      await app2.close();
    }
  });
});