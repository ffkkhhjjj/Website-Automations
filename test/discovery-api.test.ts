/**
 * Discovery API + admin tests (brief 8B) — run against the throwaway DB created
 * by test/global-setup.ts, via the built Fastify app and app.inject().
 *
 * Covers:
 *  - 401 unauthenticated on every discovery API route;
 *  - 403 read-scope API key on POST create/retry/cancel; read key allowed on GETs;
 *  - admin-scope API key allowed on POST;
 *  - owner JWT POST /jobs → 202 + PENDING job (run is async — never blocks the
 *    response, a background throw cannot surface as a 500);
 *  - honest failure: with no provider configured the background run marks the
 *    job FAILED with a discovery_provider_unconfigured exception row (no fake
 *    success);
 *  - POST body validation → 400;
 *  - GET list + detail shapes; 404/400 handling;
 *  - retry only from a final status (409 otherwise) and bumps attempts;
 *    max attempts → 409;
 *  - cancel: PENDING job with no live runner → CANCELED (direct); RUNNING job
 *    with no runner in this process → honest 409; finished job → 409;
 *  - audit rows: DISCOVERY_JOB_CREATED / RETRIED / CANCELED with actor;
 *  - admin page + static assets served (200).
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import {
  users,
  apiKeys,
  auditLogs,
  exceptions,
  discoveryJobs,
  systemSettings,
} from '../src/db/schema';
import { buildAuthApp } from '../src/auth/client';
import { hashPassword } from '../src/auth/password';
import { seedSystemSettings } from '../src/db/seed-settings';
import { settingsService } from '../src/config/singleton';
import {
  registerDiscoveryRoutes,
  DISCOVERY_JOBS_ROUTE,
  DISCOVERY_JOB_BY_ID_ROUTE,
  DISCOVERY_JOB_RETRY_ROUTE,
  DISCOVERY_JOB_CANCEL_ROUTE,
} from '../src/discovery/routes';
import { registerDiscoveryAdminRoutes, DISCOVERY_PAGE_ROUTE } from '../src/discovery/admin';

interface TestCtx {
  app: Awaited<ReturnType<typeof buildAuthApp>>;
  ownerEmail: string;
  ownerPassword: string;
  readKey: string;
  adminKey: string;
}

const ctx: TestCtx = {
  app: null as never,
  ownerEmail: '',
  ownerPassword: 'sTr0ng-P@ssw0rd-42!',
  readKey: '',
  adminKey: '',
};

/** Every job id this suite created (API or direct insert) — cleaned in afterAll. */
const jobIds = new Set<string>();

function get(path: string, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: 'GET', url: path, headers });
}
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  // No content-type without a payload: an empty JSON body would be a client
  // error (Fastify refuses to parse Content-Length: 0 as JSON), and real
  // callers POST /retry and /cancel with no body at all.
  const withBody = body !== undefined;
  return ctx.app.inject({
    method: 'POST',
    url: path,
    payload: withBody ? body : undefined,
    headers: { ...(withBody ? { 'content-type': 'application/json' } : {}), ...headers },
  });
}

async function loginAccess(): Promise<string> {
  const res = await post('/auth/login', { email: ctx.ownerEmail, password: ctx.ownerPassword });
  expect(res.statusCode).toBe(200);
  return res.json().access_token as string;
}

async function createKey(name: string, scope: 'read' | 'admin'): Promise<string> {
  const access = await loginAccess();
  const res = await post(
    '/auth/keys',
    { name: `${name}-${Date.now()}`, scope },
    { authorization: `Bearer ${access}` },
  );
  expect(res.statusCode).toBe(201);
  return res.json().api_key as string;
}

/** Direct-insert a job row (bypasses the API) with the given status/attempts. */
async function insertJob(
  status: 'PENDING' | 'RUNNING' | 'FAILED',
  attempts = 0,
): Promise<string> {
  const [row] = await db
    .insert(discoveryJobs)
    .values({
      industry: 'plumbing',
      state: 'TX',
      provider: 'none',
      status,
      attempts,
      ...(status === 'FAILED' ? { error: 'seeded failure', finished_at: new Date() } : {}),
      ...(status === 'RUNNING' ? { started_at: new Date() } : {}),
    })
    .returning({ id: discoveryJobs.id });
  jobIds.add(row!.id);
  return row!.id;
}

/** Poll the DB until the job reaches one of `statuses` (background runs are async). */
async function waitForStatus(
  jobId: string,
  statuses: string[],
  timeoutMs = 5000,
): Promise<{ status: string; attempts: number; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).limit(1);
    if (row && statuses.includes(row.status)) {
      return { status: row.status, attempts: row.attempts, error: row.error };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `job ${jobId} did not reach ${statuses.join('/')} within ${timeoutMs}ms (last: ${row?.status ?? 'missing'})`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setSettingRaw(key: string, value: unknown): Promise<void> {
  await db.update(systemSettings).set({ value }).where(eq(systemSettings.key, key));
  (settingsService as unknown as { cache: Map<string, unknown> }).cache.delete(key);
}

beforeAll(async () => {
  // Honest unconfigured path under test: no provider credential in env.
  delete process.env.DISCOVERY_API_KEY;
  await seedSystemSettings();

  ctx.ownerEmail = `disc-api-owner-${Date.now()}@test.local`;
  const hash = await hashPassword(ctx.ownerPassword);
  await db.insert(users).values({ email: ctx.ownerEmail, password_hash: hash, role: 'OWNER' });

  ctx.app = await buildAuthApp({ registerRateLimit: false });
  await registerDiscoveryRoutes(ctx.app);
  await registerDiscoveryAdminRoutes(ctx.app);

  ctx.readKey = await createKey('disc-read', 'read');
  ctx.adminKey = await createKey('disc-admin', 'admin');
});

afterAll(async () => {
  if (ctx.app) await ctx.app.close();
  // Clean in dependency order: audits + exceptions reference job ids; errors
  // cascade with the job row; keys/users cascade sessions.
  const ids = [...jobIds];
  if (ids.length > 0) {
    await db.delete(auditLogs).where(and(eq(auditLogs.source, 'discovery'), inArray(auditLogs.entity_id, ids)));
    await db.delete(exceptions).where(and(eq(exceptions.entity_type, 'discovery_job'), inArray(exceptions.entity_id, ids)));
  }
  await db.delete(auditLogs).where(eq(auditLogs.source, 'discovery'));
  await db.delete(discoveryJobs);
  await db.delete(apiKeys);
  await db.delete(users).where(eq(users.email, ctx.ownerEmail));
  // Restore anything this suite mutated.
  await setSettingRaw('discovery.max_attempts', 3);
  await db.delete(auditLogs).where(eq(auditLogs.source, 'settings'));
  await pool.end();
});

/* ----------------------------------------------------------------------------
 * Auth
 * ------------------------------------------------------------------------- */

describe('auth', () => {
  it('(1a) 401 unauthenticated on every discovery API route', async () => {
    const routes: [string, 'GET' | 'POST'][] = [
      [DISCOVERY_JOBS_ROUTE, 'GET'],
      [DISCOVERY_JOBS_ROUTE, 'POST'],
      [`${DISCOVERY_JOBS_ROUTE}/00000000-0000-0000-0000-000000000001/retry`, 'POST'],
      [`${DISCOVERY_JOBS_ROUTE}/00000000-0000-0000-0000-000000000001/cancel`, 'POST'],
      [`${DISCOVERY_JOBS_ROUTE}/00000000-0000-0000-0000-000000000001`, 'GET'],
    ];
    for (const [url, method] of routes) {
      const res =
        method === 'GET'
          ? await ctx.app.inject({ method, url })
          : await post(url, { industry: 'plumbing', state: 'TX' });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe('missing_credentials');
    }
  });

  it('(1b) 403 read-scope key on POST create/retry/cancel', async () => {
    const headers = { authorization: `Bearer ${ctx.readKey}` };
    const create = await post(DISCOVERY_JOBS_ROUTE, { industry: 'plumbing', state: 'TX' }, headers);
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('insufficient_scope');

    const jobId = await insertJob('FAILED');
    const retry = await post(`${DISCOVERY_JOBS_ROUTE}/${jobId}/retry`, undefined, headers);
    expect(retry.statusCode).toBe(403);
    const cancel = await post(`${DISCOVERY_JOBS_ROUTE}/${jobId}/cancel`, undefined, headers);
    expect(cancel.statusCode).toBe(403);
  });

  it('(1c) read-scope key CAN read list + detail', async () => {
    const headers = { authorization: `Bearer ${ctx.readKey}` };
    const list = await get(DISCOVERY_JOBS_ROUTE, headers);
    expect(list.statusCode).toBe(200);
    const jobId = await insertJob('PENDING');
    const detail = await get(`${DISCOVERY_JOBS_ROUTE}/${jobId}`, headers);
    expect(detail.statusCode).toBe(200);
  });

  it('(1d) admin-scope key CAN create (owner or ADMIN-scope for writes)', async () => {
    const res = await post(
      DISCOVERY_JOBS_ROUTE,
      { industry: 'plumbing', state: 'TX' },
      { authorization: `Bearer ${ctx.adminKey}` },
    );
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job.id as string;
    jobIds.add(jobId);
    // Audit actor is the API key.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.source, 'discovery'), eq(auditLogs.entity_id, jobId), eq(auditLogs.action, 'DISCOVERY_JOB_CREATED')));
    expect(audit).toBeTruthy();
    expect(audit!.actor_type).toBe('API');
  });
});

/* ----------------------------------------------------------------------------
 * POST /jobs — create + async run (honest unconfigured failure)
 * ------------------------------------------------------------------------- */

describe('POST /api/discovery/jobs', () => {
  it('(2a) owner JWT → 202 with PENDING job; background run fails honestly (no fake success)', async () => {
    const access = await loginAccess();
    const res = await post(
      DISCOVERY_JOBS_ROUTE,
      { industry: 'plumbing', state: 'TX', city: 'Austin' },
      { authorization: `Bearer ${access}` },
    );
    // The response returns before the run settles — the run is asynchronous.
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.job.id).toBeTruthy();
    expect(body.job.status).toBe('PENDING');
    expect(body.job.industry).toBe('plumbing');
    expect(body.job.state).toBe('TX');
    expect(body.job.city).toBe('Austin');
    expect(body.job.provider).toBe('none');
    expect(body.job.attempts).toBe(0);
    expect(body.job.progress).toEqual({
      records_fetched: 0, ingested: 0, duplicates_skipped: 0, invalid_skipped: 0, errors: 0,
    });
    const jobId = body.job.id as string;
    jobIds.add(jobId);

    // Creation audit with the USER actor.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.source, 'discovery'), eq(auditLogs.entity_id, jobId), eq(auditLogs.action, 'DISCOVERY_JOB_CREATED')));
    expect(audit).toBeTruthy();
    expect(audit!.actor_type).toBe('USER');

    // The background run must settle honestly: provider unconfigured → FAILED
    // with an exception row naming the missing env var. Never a fake success.
    const final = await waitForStatus(jobId, ['FAILED']);
    expect(final.status).toBe('FAILED');
    expect(final.error).toContain('DISCOVERY_API_KEY');
    const [exc] = await db.select().from(exceptions).where(eq(exceptions.entity_id, jobId));
    expect(exc?.category).toBe('discovery_provider_unconfigured');
    expect(exc?.priority).toBe('MEDIUM');
  });

  it('(2b) validation: missing industry / bad state / bad city → 400', async () => {
    const access = await loginAccess();
    const headers = { authorization: `Bearer ${access}` };
    const noIndustry = await post(DISCOVERY_JOBS_ROUTE, { state: 'TX' }, headers);
    expect(noIndustry.statusCode).toBe(400);
    const badState = await post(DISCOVERY_JOBS_ROUTE, { industry: 'plumbing', state: 'Texas' }, headers);
    expect(badState.statusCode).toBe(400);
    const notAState = await post(DISCOVERY_JOBS_ROUTE, { industry: 'plumbing', state: 'ZZ' }, headers);
    expect(notAState.statusCode).toBe(400);
    const badCity = await post(DISCOVERY_JOBS_ROUTE, { industry: 'plumbing', state: 'TX', city: 42 }, headers);
    expect(badCity.statusCode).toBe(400);
  });
});

/* ----------------------------------------------------------------------------
 * GET /jobs + /jobs/:id — shapes
 * ------------------------------------------------------------------------- */

describe('GET list + detail', () => {
  it('(3a) list: most recent first, full job shape', async () => {
    const a = await insertJob('FAILED');
    const b = await insertJob('PENDING');
    const access = await loginAccess();
    const res = await get(DISCOVERY_JOBS_ROUTE, { authorization: `Bearer ${access}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.count).toBe(body.jobs.length);
    const jobs = body.jobs as Array<Record<string, unknown>>;
    // Most recent first: the last inserted id appears before earlier ones.
    const idxB = jobs.findIndex((j) => j.id === b);
    const idxA = jobs.findIndex((j) => j.id === a);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA);
    const job = jobs[idxB]!;
    for (const field of [
      'id', 'status', 'provider', 'industry', 'state', 'city', 'attempts',
      'progress', 'error', 'started_at', 'finished_at', 'cancelled_at', 'created_at',
    ]) {
      expect(job, `field ${field}`).toHaveProperty(field);
    }
    expect(typeof job.created_at).toBe('string');
  });

  it('(3b) detail: job + error rows + honest businesses estimate; 404/400', async () => {
    const access = await loginAccess();
    const jobId = await insertJob('FAILED');
    const res = await get(`${DISCOVERY_JOBS_ROUTE}/${jobId}`, { authorization: `Bearer ${access}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job.id).toBe(jobId);
    expect(body.job.status).toBe('FAILED');
    expect(Array.isArray(body.errors)).toBe(true);
    expect(typeof body.errors_total).toBe('number');
    expect(body.businesses.total).toBe(0);
    expect(body.businesses.note).toContain('does not tag businesses');
    expect(body.businesses.window.from).toBeTruthy();

    const missing = await get(
      `${DISCOVERY_JOBS_ROUTE}/00000000-0000-0000-0000-0000000000ff`,
      { authorization: `Bearer ${access}` },
    );
    expect(missing.statusCode).toBe(404);
    const badId = await get(`${DISCOVERY_JOBS_ROUTE}/not-a-uuid`, { authorization: `Bearer ${access}` });
    expect(badId.statusCode).toBe(400);
  });
});

/* ----------------------------------------------------------------------------
 * Retry
 * ------------------------------------------------------------------------- */

describe('POST /jobs/:id/retry', () => {
  it('(4a) retry only from a final status; bumps attempts and re-runs', async () => {
    const access = await loginAccess();
    const headers = { authorization: `Bearer ${access}` };

    // Non-final jobs → 409.
    const runningId = await insertJob('RUNNING');
    const retryRunning = await post(`${DISCOVERY_JOBS_ROUTE}/${runningId}/retry`, undefined, headers);
    expect(retryRunning.statusCode).toBe(409);
    expect(retryRunning.json().error.code).toBe('invalid_state');
    const pendingId = await insertJob('PENDING');
    const retryPending = await post(`${DISCOVERY_JOBS_ROUTE}/${pendingId}/retry`, undefined, headers);
    expect(retryPending.statusCode).toBe(409);

    // Final (FAILED) job → 202; background retry bumps attempts to 1 and
    // re-runs. The retry is async: wait until attempts bumped, then the
    // re-run settles back to FAILED (provider still unconfigured).
    const failedId = await insertJob('FAILED', 0);
    const res = await post(`${DISCOVERY_JOBS_ROUTE}/${failedId}/retry`, undefined, headers);
    expect(res.statusCode).toBe(202);
    const deadline = Date.now() + 5000;
    let final: { status: string; attempts: number; error: string | null } | null = null;
    for (;;) {
      const cur = await waitForStatus(failedId, ['FAILED']);
      if (cur.attempts >= 1) { final = cur; break; }
      if (Date.now() > deadline) throw new Error(`retry did not bump attempts within 5s (last: ${JSON.stringify(cur)})`);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(final!.attempts).toBe(1);
    expect(final!.status).toBe('FAILED');

    // Audit row for the retry.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.source, 'discovery'), eq(auditLogs.entity_id, failedId), eq(auditLogs.action, 'DISCOVERY_JOB_RETRIED')));
    expect(audit).toBeTruthy();
  });

  it('(4b) retry past max attempts → 409', async () => {
    await setSettingRaw('discovery.max_attempts', 1);
    try {
      const access = await loginAccess();
      const failedId = await insertJob('FAILED', 1); // attempts already at max
      const res = await post(
        `${DISCOVERY_JOBS_ROUTE}/${failedId}/retry`,
        undefined,
        { authorization: `Bearer ${access}` },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('max_attempts');
    } finally {
      await setSettingRaw('discovery.max_attempts', 3);
    }
  });
});

/* ----------------------------------------------------------------------------
 * Cancel
 * ------------------------------------------------------------------------- */

describe('POST /jobs/:id/cancel', () => {
  it('(5a) PENDING job with no live runner → CANCELED (direct) + audit', async () => {
    const access = await loginAccess();
    const jobId = await insertJob('PENDING');
    const res = await post(
      `${DISCOVERY_JOBS_ROUTE}/${jobId}/cancel`,
      undefined,
      { authorization: `Bearer ${access}` },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe('CANCELED');
    const [row] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).limit(1);
    expect(row!.status).toBe('CANCELED');
    expect(row!.cancelled_at).toBeTruthy();
    expect(row!.finished_at).toBeTruthy();
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.source, 'discovery'), eq(auditLogs.entity_id, jobId), eq(auditLogs.action, 'DISCOVERY_JOB_CANCELED')));
    expect(audit).toBeTruthy();
  });

  it('(5b) RUNNING with no runner in this process → honest 409; finished → 409', async () => {
    const access = await loginAccess();
    const headers = { authorization: `Bearer ${access}` };

    const runningId = await insertJob('RUNNING');
    const res = await post(`${DISCOVERY_JOBS_ROUTE}/${runningId}/cancel`, undefined, headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_active_runner');

    const canceledId = await insertJob('PENDING');
    await post(`${DISCOVERY_JOBS_ROUTE}/${canceledId}/cancel`, undefined, headers);
    const again = await post(`${DISCOVERY_JOBS_ROUTE}/${canceledId}/cancel`, undefined, headers);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invalid_state');
  });
});

/* ----------------------------------------------------------------------------
 * Admin page + assets
 * ------------------------------------------------------------------------- */

describe('admin page', () => {
  it('(6a) page + CSS + JS served (200); API stays auth-gated', async () => {
    const page = await get(DISCOVERY_PAGE_ROUTE);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('id="start-form"');

    const css = await get('/admin/assets/discovery.css');
    expect(css.statusCode).toBe(200);
    const js = await get('/admin/assets/discovery.js');
    expect(js.statusCode).toBe(200);

    // The data endpoints behind the page remain authenticated.
    const noAuth = await get(DISCOVERY_JOBS_ROUTE);
    expect(noAuth.statusCode).toBe(401);
  });
});
