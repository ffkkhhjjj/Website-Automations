/**
 * Businesses (leads console) API tests — run against the throwaway DB created
 * by test/global-setup.ts, via the built Fastify app and app.inject().
 *
 * Covers:
 *  - 401 unauthenticated on list/detail/lifecycle;
 *  - 403 read-scope API key on POST lifecycle; read key allowed on GETs;
 *  - GET /api/businesses: pagination shape, search/phone/industry/city/state/
 *    lifecycle filters, sort/order, invalid state/sort → 400;
 *  - GET /api/businesses/:id: full detail shape incl. legalTransitions from the
 *    live transition map, latestScore, history; 404/400 handling;
 *  - POST /api/businesses/:id/lifecycle: valid transition (ANALYZED→QUALIFIED,
 *    writes audit + history), invalid transition → 422 with legalTargets,
 *    same-state → 422, rejection without reason → 400, rejection with reason →
 *    REJECTED + rejections row, unknown rejection reason → 400,
 *    reason/target mismatch (OPT_OUT reasons → DO_NOT_CONTACT) → 422,
 *    not found → 404.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import {
  users,
  businesses,
  leadScores,
  leadStateHistory,
  auditLogs,
  rejections,
  apiKeys,
} from '../src/db/schema';
import { buildAuthApp } from '../src/auth/client';
import { hashPassword } from '../src/auth/password';
import { seedSystemSettings } from '../src/db/seed-settings';
import {
  registerBusinessesRoutes,
  BUSINESSES_ROUTE,
  BUSINESS_LIFECYCLE_ROUTE,
} from '../src/businesses/routes';

interface TestCtx {
  app: Awaited<ReturnType<typeof buildAuthApp>>;
  ownerEmail: string;
  ownerPassword: string;
  readKey: string;
  adminKey: string;
  bizAnalyzed: string;
  bizDiscovered: string;
  bizQualified: string;
}

const ctx: TestCtx = {
  app: null as never,
  ownerEmail: '',
  ownerPassword: 'sTr0ng-P@ssw0rd-42!',
  readKey: '',
  adminKey: '',
  bizAnalyzed: '',
  bizDiscovered: '',
  bizQualified: '',
};

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
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
  const res = await post('/auth/keys', { name, scope }, auth(access));
  expect(res.statusCode).toBe(201);
  return res.json().api_key as string;
}

async function seedBusinesses(): Promise<void> {
  const rows = await db
    .insert(businesses)
    .values([
      {
        business_name: 'Console Test Plumbing Alpha',
        industry: 'plumbing',
        city: 'Austin',
        state: 'TX',
        phone: '(512) 555-0101',
        website_url: 'https://alpha-plumbing.example.com',
        source: 'manual',
        rating: '4.5',
        review_count: 42,
        lifecycle_state: 'ANALYZED',
      },
      {
        business_name: 'Console Test Plumbing Beta',
        industry: 'plumbing',
        city: 'Dallas',
        state: 'TX',
        phone: '(214) 555-0202',
        source: 'manual',
        lifecycle_state: 'DISCOVERED',
      },
      {
        business_name: 'Console Test HVAC Gamma',
        industry: 'hvac',
        city: 'Austin',
        state: 'TX',
        phone: '(512) 555-0303',
        source: 'manual',
        lifecycle_state: 'QUALIFIED',
      },
    ])
    .returning({ id: businesses.id });
  ctx.bizAnalyzed = rows[0]!.id;
  ctx.bizDiscovered = rows[1]!.id;
  ctx.bizQualified = rows[2]!.id;

  await db.insert(leadScores).values({
    business_id: ctx.bizAnalyzed,
    website_quality_score: 55,
    business_opportunity_score: 70,
    lead_priority_score: '62.50',
    classification: 'SECONDARY',
  });
}

beforeAll(async () => {
  await seedSystemSettings();

  ctx.ownerEmail = `biz-owner-${Date.now()}@test.local`;
  const hash = await hashPassword(ctx.ownerPassword);
  await db.insert(users).values({ email: ctx.ownerEmail, password_hash: hash, role: 'OWNER' });

  ctx.app = await buildAuthApp({ registerRateLimit: false });
  await registerBusinessesRoutes(ctx.app);

  ctx.readKey = await createKey(`biz-read-${Date.now()}`, 'read');
  ctx.adminKey = await createKey(`biz-admin-${Date.now()}`, 'admin');

  await seedBusinesses();
});

afterAll(async () => {
  await db.delete(rejections);
  await db.delete(leadStateHistory);
  await db.delete(leadScores);
  await db.delete(businesses);
  await db.delete(auditLogs).where(eq(auditLogs.source, 'auth'));
  await db.delete(auditLogs).where(eq(auditLogs.source, 'lifecycle'));
  await db.delete(apiKeys);
  await db.delete(users).where(eq(users.email, ctx.ownerEmail));
  await pool.end();
});

describe('auth guards', () => {
  it('401 unauthenticated on list/detail/lifecycle', async () => {
    expect((await get(BUSINESSES_ROUTE)).statusCode).toBe(401);
    expect((await get(`${BUSINESSES_ROUTE}/${ctx.bizAnalyzed}`)).statusCode).toBe(401);
    expect(
      (await post(BUSINESS_LIFECYCLE_ROUTE.replace(':businessId', ctx.bizAnalyzed), { to_state: 'QUALIFIED' })).statusCode,
    ).toBe(401);
  });

  it('read-scope key: GETs allowed, lifecycle POST → 403', async () => {
    expect((await get(BUSINESSES_ROUTE, auth(ctx.readKey))).statusCode).toBe(200);
    expect((await get(`${BUSINESSES_ROUTE}/${ctx.bizAnalyzed}`, auth(ctx.readKey))).statusCode).toBe(200);
    const res = await post(
      BUSINESS_LIFECYCLE_ROUTE.replace(':businessId', ctx.bizAnalyzed),
      { to_state: 'QUALIFIED' },
      auth(ctx.readKey),
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/businesses', () => {
  it('returns paginated shape with seeded rows', async () => {
    const access = await loginAccess();
    const res = await get(`${BUSINESSES_ROUTE}?per_page=2&page=1`, auth(access));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.perPage).toBe(2);
    expect(body.page).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.totalPages).toBeGreaterThanOrEqual(2);
    expect(body.businesses.length).toBe(2);
    const first = body.businesses[0];
    for (const k of ['id', 'businessName', 'industry', 'lifecycleState', 'source', 'createdAt']) {
      expect(first).toHaveProperty(k);
    }
  });

  it('filters: search, industry, city, state, lifecycle_state', async () => {
    const access = await loginAccess();
    const h = auth(access);

    const search = await get(`${BUSINESSES_ROUTE}?search=Alpha`, h);
    expect(search.json().businesses.map((b: { businessName: string }) => b.businessName)).toEqual([
      'Console Test Plumbing Alpha',
    ]);

    const industry = await get(`${BUSINESSES_ROUTE}?industry=hvac`, h);
    expect(industry.json().businesses.map((b: { businessName: string }) => b.businessName)).toEqual([
      'Console Test HVAC Gamma',
    ]);

    const city = await get(`${BUSINESSES_ROUTE}?city=Dallas`, h);
    expect(city.json().businesses.map((b: { businessName: string }) => b.businessName)).toEqual([
      'Console Test Plumbing Beta',
    ]);

    const state = await get(`${BUSINESSES_ROUTE}?state=tx&industry=plumbing`, h);
    expect(state.json().total).toBe(2);

    const lc = await get(`${BUSINESSES_ROUTE}?lifecycle_state=QUALIFIED`, h);
    expect(lc.json().businesses.every((b: { lifecycleState: string }) => b.lifecycleState === 'QUALIFIED')).toBe(true);
    expect(lc.json().businesses.map((b: { businessName: string }) => b.businessName)).toContain('Console Test HVAC Gamma');
  });

  it('phone filter matches digits across formatting', async () => {
    const access = await loginAccess();
    const res = await get(`${BUSINESSES_ROUTE}?phone=5125550101`, auth(access));
    expect(res.json().businesses.map((b: { businessName: string }) => b.businessName)).toEqual([
      'Console Test Plumbing Alpha',
    ]);
  });

  it('sort=rating desc orders highest first', async () => {
    const access = await loginAccess();
    const res = await get(`${BUSINESSES_ROUTE}?sort=rating&order=desc&per_page=100`, auth(access));
    expect(res.statusCode).toBe(200);
    const ratings = res.json().businesses.map((b: { rating: number | null }) => b.rating);
    const nonNull = ratings.filter((r: number | null) => r !== null) as number[];
    expect(nonNull[0]).toBe(4.5);
    for (let i = 1; i < nonNull.length; i++) expect(nonNull[i - 1]).toBeGreaterThanOrEqual(nonNull[i]!);
  });

  it('invalid lifecycle_state / sort / order → 400', async () => {
    const access = await loginAccess();
    const h = auth(access);
    expect((await get(`${BUSINESSES_ROUTE}?lifecycle_state=BOGUS`, h)).statusCode).toBe(400);
    expect((await get(`${BUSINESSES_ROUTE}?sort=bogus`, h)).statusCode).toBe(400);
    expect((await get(`${BUSINESSES_ROUTE}?order=sideways`, h)).statusCode).toBe(400);
  });

  it('pagination: page 2 differs from page 1', async () => {
    const access = await loginAccess();
    const h = auth(access);
    const p1 = await get(`${BUSINESSES_ROUTE}?per_page=2&page=1`, h);
    const p2 = await get(`${BUSINESSES_ROUTE}?per_page=2&page=2`, h);
    expect(p1.json().businesses[0].id).not.toBe(p2.json().businesses[0].id);
  });
});

describe('GET /api/businesses/:id', () => {
  it('returns full detail with live legalTransitions + latestScore', async () => {
    const access = await loginAccess();
    const res = await get(`${BUSINESSES_ROUTE}/${ctx.bizAnalyzed}`, auth(access));
    expect(res.statusCode).toBe(200);
    const b = res.json().business;
    expect(b.businessName).toBe('Console Test Plumbing Alpha');
    expect(b.lifecycleState).toBe('ANALYZED');
    // Live map: ANALYZED → QUALIFIED, REJECTED.
    expect(b.legalTransitions).toEqual(expect.arrayContaining(['QUALIFIED', 'REJECTED']));
    expect(b.latestScore.websiteQualityScore).toBe(55);
    expect(Number(b.latestScore.leadPriorityScore)).toBe(62.5);
    expect(Array.isArray(b.websiteAnalyses)).toBe(true);
    expect(Array.isArray(b.demos)).toBe(true);
    expect(Array.isArray(b.rejections)).toBe(true);
    expect(Array.isArray(b.history)).toBe(true);
    expect(Array.isArray(b.recentAudit)).toBe(true);
  });

  it('404 unknown id, 400 malformed id', async () => {
    const access = await loginAccess();
    const h = auth(access);
    expect((await get(`${BUSINESSES_ROUTE}/00000000-0000-0000-0000-000000000000`, h)).statusCode).toBe(404);
    expect((await get(`${BUSINESSES_ROUTE}/not-a-uuid`, h)).statusCode).toBe(400);
  });
});

describe('POST /api/businesses/:id/lifecycle', () => {
  const url = (id: string) => BUSINESS_LIFECYCLE_ROUTE.replace(':businessId', id);

  it('valid transition ANALYZED→QUALIFIED writes audit + history', async () => {
    const access = await loginAccess();
    const res = await post(url(ctx.bizAnalyzed), { to_state: 'QUALIFIED', reason: 'console test' }, auth(access));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ fromState: 'ANALYZED', toState: 'QUALIFIED' });

    const history = await db
      .select()
      .from(leadStateHistory)
      .where(and(eq(leadStateHistory.business_id, ctx.bizAnalyzed), eq(leadStateHistory.to_state, 'QUALIFIED' as never)));
    expect(history.length).toBeGreaterThanOrEqual(1);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_id, ctx.bizAnalyzed), eq(auditLogs.action, 'LEAD_STATE_CHANGED')));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('invalid transition DISCOVERED→QUALIFIED → 422 with legalTargets', async () => {
    const access = await loginAccess();
    const res = await post(url(ctx.bizDiscovered), { to_state: 'QUALIFIED' }, auth(access));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_transition');
    expect(res.json().error.legalTargets).toEqual(expect.arrayContaining(['ENRICHING', 'REJECTED']));
  });

  it('same-state transition → 422 already_in_state', async () => {
    const access = await loginAccess();
    const res = await post(url(ctx.bizDiscovered), { to_state: 'DISCOVERED' }, auth(access));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('already_in_state');
  });

  it('rejection without reason → 400 reason_required', async () => {
    const access = await loginAccess();
    const res = await post(url(ctx.bizQualified), { to_state: 'REJECTED' }, auth(access));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('reason_required');
  });

  it('unknown rejection reason → 400; OPT_OUT reasons → DO_NOT_CONTACT mismatch → 422', async () => {
    const access = await loginAccess();
    const h = auth(access);
    const bad = await post(url(ctx.bizQualified), { to_state: 'REJECTED', reason: 'x', rejection_reasons: ['NOPE'] }, h);
    expect(bad.statusCode).toBe(400);
    const mismatch = await post(
      url(ctx.bizQualified),
      { to_state: 'REJECTED', reason: 'opt out call', rejection_reasons: ['OPT_OUT'] },
      h,
    );
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe('rejection_target_mismatch');
  });

  it('rejection with reason → REJECTED + rejections row + audit', async () => {
    const access = await loginAccess();
    const res = await post(
      url(ctx.bizQualified),
      { to_state: 'REJECTED', reason: 'bad fit — test', rejection_reasons: ['BAD_DATA'] },
      auth(access),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().toState).toBe('REJECTED');
    const rej = await db.select().from(rejections).where(eq(rejections.business_id, ctx.bizQualified));
    expect(rej.map((r) => r.reason)).toContain('BAD_DATA');
    const detail = await get(`${BUSINESSES_ROUTE}/${ctx.bizQualified}`, auth(access));
    expect(detail.json().business.lifecycleState).toBe('REJECTED');
    expect(detail.json().business.legalTransitions).toEqual([]);
  });

  it('admin-scope API key may transition; 404 unknown business', async () => {
    const res = await post(url(ctx.bizDiscovered), { to_state: 'ENRICHING' }, auth(ctx.adminKey));
    expect(res.statusCode).toBe(200);
    expect(res.json().toState).toBe('ENRICHING');
    const access = await loginAccess();
    const nf = await post(url('00000000-0000-0000-0000-000000000000'), { to_state: 'ENRICHING' }, auth(access));
    expect(nf.statusCode).toBe(404);
  });
});
