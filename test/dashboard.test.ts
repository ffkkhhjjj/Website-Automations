/**
 * Owner dashboard tests — run against the built Fastify app via `app.inject()`.
 *
 * Exercises the full stack: Postgres + Drizzle + auth guards + the overview
 * service (real counts, honest zeros, prioritized exceptions, health).
 *
 * DATABASE_URL is pointed at the dedicated TEST_DATABASE_URL database by
 * vitest.config.ts (env) before any test module loads; that DB is created and
 * migrated by test/global-setup.ts.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import {
  users,
  businesses,
  leadScores,
  demos,
  outreachMessages,
  conversations,
  conversationMessages,
  exceptions,
  auditLogs,
  apiKeys,
} from '../src/db/schema';
import { buildAuthApp } from '../src/auth/client';
import { hashPassword } from '../src/auth/password';
import { registerDashboardRoutes, DASHBOARD_API_ROUTE, DASHBOARD_PAGE_ROUTE } from '../src/dashboard/routes';
import { seedSystemSettings } from '../src/db/seed-settings';

interface TestCtx {
  app: Awaited<ReturnType<typeof buildAuthApp>>;
  ownerId: string;
  ownerEmail: string;
  ownerPassword: string;
  businessId: string;
  conversationId: string;
  leadScoreId: string;
}

const ctx: TestCtx = {
  app: null as never,
  ownerId: '',
  ownerEmail: '',
  ownerPassword: '',
  businessId: '',
  conversationId: '',
  leadScoreId: '',
};

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

async function createKey(name: string, scope: 'read' | 'admin'): Promise<string> {
  const access = await loginAccess();
  const res = await post('/auth/keys', { name, scope }, { authorization: `Bearer ${access}` });
  expect(res.statusCode).toBe(201);
  return res.json().api_key as string;
}

/** Seed one fake HOT business + score + demo + reply + SENT message + exception. */
async function seedHotBusiness(): Promise<{ businessId: string; conversationId: string }> {
  const [biz] = await db
    .insert(businesses)
    .values({
      business_name: 'Acme Plumbing Co',
      industry: 'plumbing',
      city: 'Dallas',
      state: 'TX',
      website_url: 'https://acme-plumbing.example.com',
      source: 'manual',
      lifecycle_state: 'HOT',
    })
    .returning({ id: businesses.id });
  const businessId = biz!.id;

  const [score] = await db
    .insert(leadScores)
    .values({
      business_id: businessId,
      website_quality_score: 42,
      business_opportunity_score: 88,
      market_fit_score: '0.9',
      lead_priority_score: '84.5',
      classification: 'HIGH_PRIORITY',
    })
    .returning({ id: leadScores.id });

  await db.insert(demos).values({
    business_id: businessId,
    status: 'READY',
    demo_url: 'https://demo.acme-plumbing.example.com',
  });

  await db.insert(outreachMessages).values({
    business_id: businessId,
    status: 'SENT',
    subject: 'Your website could earn you more calls',
    sent_at: new Date(),
  });

  const [conv] = await db
    .insert(conversations)
    .values({ business_id: businessId })
    .returning({ id: conversations.id });
  const conversationId = conv!.id;
  await db.insert(conversationMessages).values({
    conversation_id: conversationId,
    direction: 'INBOUND',
    classification: 'INTERESTED',
    classification_confidence: '0.92',
    body: 'Hi, we could use a better website — what does this cost?',
    received_at: new Date(Date.now() - 60 * 60 * 1000),
  });

  await db.insert(exceptions).values({
    entity_type: 'outreach',
    entity_id: businessId,
    priority: 'CRITICAL',
    category: 'email_delivery',
    status: 'OPEN',
    message: 'Email provider rejected the daily quota',
  });

  ctx.businessId = businessId;
  ctx.conversationId = conversationId;
  ctx.leadScoreId = score!.id;
  return { businessId, conversationId };
}

beforeAll(async () => {
  // Fresh throwaway DB is created + migrated by global-setup; seed settings so
  // the dashboard service's hot-lead-limit read has a row/fallback.
  await seedSystemSettings();

  ctx.ownerEmail = `dash-owner-${Date.now()}@test.local`;
  ctx.ownerPassword = 'sTr0ng-P@ssw0rd-42!';
  const hash = await hashPassword(ctx.ownerPassword);
  const [owner] = await db
    .insert(users)
    .values({ email: ctx.ownerEmail, password_hash: hash, role: 'OWNER' })
    .returning({ id: users.id });
  ctx.ownerId = owner!.id;

  ctx.app = await buildAuthApp({ registerRateLimit: false });
  await registerDashboardRoutes(ctx.app, { registerRateLimit: false });
});

afterAll(async () => {
  if (ctx.app) await ctx.app.close();
  await db.delete(exceptions).where(eq(exceptions.entity_type, 'outreach'));
  await db.delete(conversations);
  await db.delete(outreachMessages);
  await db.delete(demos);
  await db.delete(leadScores);
  await db.delete(businesses);
  await db.delete(auditLogs).where(eq(auditLogs.source, 'auth'));
  await db.delete(apiKeys);
  await db.delete(users).where(eq(users.email, ctx.ownerEmail)); // cascades sessions
  await pool.end();
});

describe('GET /api/dashboard/overview', () => {
  it('(1a) 401 without credentials', async () => {
    const res = await get(DASHBOARD_API_ROUTE);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_credentials');
  });

  it('(1b) works with owner JWT and returns all expected keys with correct shapes', async () => {
    const access = await loginAccess();
    const res = await get(DASHBOARD_API_ROUTE, { authorization: `Bearer ${access}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toHaveProperty('generatedAt');
    expect(body).toHaveProperty('hotLeads');
    expect(body).toHaveProperty('counts');
    expect(body).toHaveProperty('countsMeta');
    expect(body).toHaveProperty('todayActivity');
    expect(body).toHaveProperty('exceptions');
    expect(body).toHaveProperty('health');

    expect(Array.isArray(body.hotLeads)).toBe(true);
    expect(Array.isArray(body.todayActivity)).toBe(true);
    expect(Array.isArray(body.exceptions)).toBe(true);

    for (const key of [
      'leadsFound', 'leadsQualified', 'demosCreated', 'emailsSent', 'replies',
      'interested', 'sales', 'revenue', 'mrr', 'demoViews',
      'emailBounces', 'unsubscribes', 'systemErrors',
    ]) {
      expect(typeof body.counts[key]).toBe('number');
    }

    // Honest zero provenance: not-wired metrics are explicit.
    expect(body.countsMeta.revenue).toEqual({ value: 0, wired: false, source: expect.any(String) });
    expect(body.countsMeta.mrr.value).toBe(0);
    expect(body.countsMeta.demoViews.value).toBe(0);

    expect(typeof body.health.serverUp).toBe('boolean');
    expect(typeof body.health.dbReachable).toBe('boolean');
    expect(body.health).toHaveProperty('tasksByStatus');
    expect(body.health).toHaveProperty('taskIssues');
    expect(body.health).toHaveProperty('lastAuditAt');
  });

  it('(1c) works with a read-scope API key (authenticated read surface)', async () => {
    const key = await createKey(`dash-read-${Date.now()}`, 'read');
    const res = await get(DASHBOARD_API_ROUTE, { authorization: `Bearer ${key}` });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().hotLeads)).toBe(true);
  });
});

describe('seeded hot business appears in the overview', () => {
  it('(2a) hotLeads populated with all spec fields', async () => {
    const { businessId, conversationId } = await seedHotBusiness();
    const access = await loginAccess();
    const res = await get(DASHBOARD_API_ROUTE, { authorization: `Bearer ${access}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.hotLeads.length).toBeGreaterThan(0);
    const lead = body.hotLeads.find((l: { businessId: string }) => l.businessId === businessId);
    expect(lead).toBeTruthy();
    expect(lead.businessName).toBe('Acme Plumbing Co');
    expect(lead.city).toBe('Dallas');
    expect(lead.state).toBe('TX');
    expect(lead.websiteUrl).toBe('https://acme-plumbing.example.com');
    expect(Number(lead.leadPriorityScore)).toBe(84.5);
    expect(lead.websiteQualityScore).toBe(42);
    expect(lead.lifecycleState).toBe('HOT');
    expect(String(lead.latestReplySnippet)).toContain('better website');
    expect(lead.intent).toBe('INTERESTED');
    expect(Number(lead.confidence)).toBeCloseTo(0.92, 2);
    expect(typeof lead.suggestedAction).toBe('string');
    expect(lead.demoUrl).toBe('https://demo.acme-plumbing.example.com');
    void conversationId;

    // counts reflect the seeded rows
    expect(body.counts.leadsFound).toBeGreaterThanOrEqual(1);
    expect(body.counts.leadsQualified).toBeGreaterThanOrEqual(1);
    expect(body.counts.demosCreated).toBeGreaterThanOrEqual(1);
    expect(body.counts.emailsSent).toBeGreaterThanOrEqual(1);
    expect(body.counts.replies).toBeGreaterThanOrEqual(1);
    expect(body.counts.interested).toBeGreaterThanOrEqual(1);
  });

  it('(2b) exceptions include the CRITICAL row and are returned prioritized first', async () => {
    const access = await loginAccess();
    const res = await get(DASHBOARD_API_ROUTE, { authorization: `Bearer ${access}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const excs = body.exceptions as { priority: string; message: string }[];
    expect(excs.length).toBeGreaterThan(0);
    // Seeded CRITICAL first (before any MEDIUM/LOW)
    expect(excs[0].priority).toBe('CRITICAL');
    expect(excs.some((e) => String(e.message).includes('quota'))).toBe(true);
    expect(body.counts.systemErrors).toBeGreaterThanOrEqual(1);

    // todayActivity picks up the audit rows written above
    expect(Array.isArray(body.todayActivity)).toBe(true);
  });
});

describe('honest-zero case on a fresh DB', () => {
  it('(3) counts all 0, hotLeads [], health shows db reachable', async () => {
    // Remove every business/score/demo/message/exception the tests seeded so far.
    await db.delete(conversations);
    await db.delete(exceptions).where(eq(exceptions.entity_type, 'outreach'));
    await db.delete(outreachMessages);
    await db.delete(demos);
    await db.delete(leadScores);
    await db.delete(businesses);

    const access = await loginAccess();
    const res = await get(DASHBOARD_API_ROUTE, { authorization: `Bearer ${access}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    for (const key of [
      'leadsFound', 'leadsQualified', 'demosCreated', 'emailsSent', 'replies',
      'interested', 'sales', 'revenue', 'mrr', 'demoViews',
      'emailBounces', 'unsubscribes', 'systemErrors',
    ]) {
      expect(body.counts[key]).toBe(0);
    }
    expect(body.hotLeads).toEqual([]);
    expect(body.exceptions).toEqual([]);
    expect(body.health.serverUp).toBe(true);
    expect(body.health.dbReachable).toBe(true);
    expect(body.health.taskIssues).toEqual([]);
  });
});

describe('dashboard page + assets', () => {
  it('(4a) GET /dashboard serves the page shell (200 HTML)', async () => {
    const res = await get(DASHBOARD_PAGE_ROUTE);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Owner Dashboard');
    expect(res.body).toContain('Hot leads');
  });

  it('(4b) static assets are served (dashboard.css + dashboard.js)', async () => {
    const css = await get('/dashboard/assets/dashboard.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    const js = await get('/dashboard/assets/dashboard.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
  });

  it('(4c) login page served', async () => {
    const res = await get('/dashboard/auth/login');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Owner login');
  });
});