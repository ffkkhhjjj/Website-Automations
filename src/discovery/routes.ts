/**
 * Discovery API — authenticated Fastify routes over the discovery core (brief 8B).
 *
 *   POST /api/discovery/jobs            {industry, state, city?} → 202 + job (run is async)
 *   POST /api/discovery/jobs/:id/retry  retry a FINISHED job (bumps attempts)  → 202
 *   POST /api/discovery/jobs/:id/cancel cancel an active job                    → 200
 *   GET  /api/discovery/jobs            list jobs (most recent first)
 *   GET  /api/discovery/jobs/:id        one job + its error rows + ingested estimate
 *
 * Auth model (mirrors src/config/routes.ts):
 *   - GETs: owner JWT or ANY API key (read scope is inherent to API keys);
 *   - POSTs (create/retry/cancel): owner JWT or ADMIN-scope API key;
 *   - 401 unauthenticated, 403 insufficient scope.
 *
 * Honesty rules:
 *   - POST /jobs ALWAYS kicks off the real run via runDiscoveryJob in the
 *     background (the response never waits for it, and a background throw is
 *     caught + logged — it can never surface as a 500 or kill the reply);
 *   - with no provider configured the run FAILS the job honestly (FAILED +
 *     exception row) — never a fake success;
 *   - the runner does NOT tag ingested businesses with job ids (out of scope),
 *     so GET /:id reports businesses matched on target + run window and says
 *     exactly that in a note.
 *
 * Audit: every create/retry/cancel writes an audit_logs row (action
 * DISCOVERY_JOB_CREATED / DISCOVERY_JOB_RETRIED / DISCOVERY_JOB_CANCELED,
 * actor from the authenticated principal, entity discovery_job).
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { discoveryJobs, discoveryJobErrors, businesses, exceptions } from '../db/schema';
import type { DiscoveryJobProgress } from '../db/schema';
import {
  authenticatePreHandler,
  requireScopePreHandler,
  type AuthPrincipal,
} from '../auth/middleware';
import type { AuthConfig } from '../auth/config';
import { writeAudit } from '../auth/audit';
import { settings } from '../config/singleton';
import { createDiscoveryJob, runDiscoveryJob, retryDiscoveryJob, createCancelToken } from './runner';
import type { CancelToken, DiscoveryJobRow } from './runner';
import { normalizeState } from './normalize';

/** Route constants (exported for tests + README). */
export const DISCOVERY_JOBS_ROUTE = '/api/discovery/jobs';
export const DISCOVERY_JOB_BY_ID_ROUTE = '/api/discovery/jobs/:id';
export const DISCOVERY_JOB_RETRY_ROUTE = '/api/discovery/jobs/:id/retry';
export const DISCOVERY_JOB_CANCEL_ROUTE = '/api/discovery/jobs/:id/cancel';

/** Statuses a job can be retried from (mirrors the runner's rule). */
const FINAL_STATUSES = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELED']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ZERO_PROGRESS: DiscoveryJobProgress = {
  records_fetched: 0,
  ingested: 0,
  duplicates_skipped: 0,
  invalid_skipped: 0,
  errors: 0,
};

/**
 * Cancel tokens for runs started in THIS process, keyed by job id. The cancel
 * endpoint flips the token; the runner checks it between batches. Entries are
 * removed when the run settles.
 */
const activeTokens = new Map<string, CancelToken>();

/** Serialized job JSON shared by list/detail/create/retry/cancel responses. */
function toJobJson(job: DiscoveryJobRow) {
  return {
    id: job.id,
    status: job.status,
    provider: job.provider,
    industry: job.industry,
    state: job.state,
    city: job.city,
    attempts: job.attempts,
    progress: job.progress ?? ZERO_PROGRESS,
    error: job.error,
    started_at: job.started_at ? job.started_at.toISOString() : null,
    finished_at: job.finished_at ? job.finished_at.toISOString() : null,
    cancelled_at: job.cancelled_at ? job.cancelled_at.toISOString() : null,
    created_at: job.created_at.toISOString(),
  };
}

/** Audit actor from the authenticated principal (USER for JWT, API for keys). */
function actorFrom(principal: AuthPrincipal) {
  return principal.type === 'user'
    ? { actorType: 'USER' as const, actorId: principal.userId ?? null }
    : { actorType: 'API' as const, actorId: principal.apiKeyId ?? null };
}

export interface RegisterDiscoveryRoutesOptions {
  authConfig?: AuthConfig;
  /** Per-IP limit for job-mutating POSTs per minute (default 30). */
  writeRateLimitMax?: number;
}

/**
 * Register the discovery API on an existing Fastify app (the app built by
 * buildAuthApp() already registered @fastify/rate-limit globally; the per-route
 * limits below are inert when it is not registered — same as config routes).
 */
export async function registerDiscoveryRoutes(
  app: FastifyInstance,
  opts: RegisterDiscoveryRoutesOptions = {},
): Promise<void> {
  const cfg = opts.authConfig ?? (await import('../auth/config')).loadAuthConfig();

  const preHandlerRead = [authenticatePreHandler(cfg)];
  const preHandlerWrite: NonNullable<Parameters<typeof app.post>[1]>['preHandler'] = [
    authenticatePreHandler(cfg),
    requireScopePreHandler('admin'), // owner JWT passes; API keys need admin scope
  ];
  const writeRateLimit = {
    config: { rateLimit: { max: opts.writeRateLimitMax ?? 30, timeWindow: '1 minute' } },
  } as const;

  /* ------------------------------------------------------------------------
   * POST /api/discovery/jobs — create + start a job asynchronously.
   * ---------------------------------------------------------------------- */
  app.post(
    DISCOVERY_JOBS_ROUTE,
    { preHandler: preHandlerWrite, ...writeRateLimit },
    async (req, reply) => {
      const body = (req.body ?? {}) as { industry?: unknown; state?: unknown; city?: unknown };

      const industry = typeof body.industry === 'string' ? body.industry.trim().toLowerCase() : '';
      if (!industry || industry.length > 100) {
        return reply.code(400).send({
          error: { code: 'invalid_request', message: 'industry is required (non-empty string, max 100 chars)' },
        });
      }
      const state = normalizeState(typeof body.state === 'string' ? body.state : null);
      if (!state) {
        return reply.code(400).send({
          error: { code: 'invalid_request', message: 'state must be a 2-letter US state code' },
        });
      }
      let city: string | undefined;
      if (body.city !== undefined && body.city !== null) {
        if (typeof body.city !== 'string') {
          return reply.code(400).send({ error: { code: 'invalid_request', message: 'city must be a string' } });
        }
        const c = body.city.trim();
        if (c.length > 100) {
          return reply.code(400).send({ error: { code: 'invalid_request', message: 'city must be at most 100 chars' } });
        }
        city = c.length > 0 ? c : undefined;
      }

      // The provider label comes from settings ("none" until a real provider is
      // selected). The job is still created — the run will FAIL it honestly.
      const provider = await settings.getDiscoveryProvider();
      const jobId = await createDiscoveryJob({ industry, state, city, provider });
      const [row] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).limit(1);
      if (!row) {
        return reply.code(500).send({ error: { code: 'internal_error', message: 'Failed to load created job' } });
      }

      const actor = actorFrom(req.auth);
      await writeAudit({
        ...actor,
        action: 'DISCOVERY_JOB_CREATED',
        entityType: 'discovery_job',
        entityId: jobId,
        after: { industry, state, city: city ?? null, provider, status: 'PENDING' },
        source: 'discovery',
      });

      // Background run — never awaited by the request; a throw is caught and
      // logged so it can never kill the response or crash the process.
      const token = createCancelToken();
      activeTokens.set(jobId, token);
      void runDiscoveryJob(jobId, { token }).then(
        () => undefined,
        (err: unknown) => {
          app.log.error({ err, jobId }, 'background discovery run failed');
        },
      ).finally(() => {
        activeTokens.delete(jobId);
      });

      return reply.code(202).send({
        job: toJobJson(row),
        message: 'discovery job accepted; the run is asynchronous',
      });
    },
  );

  /* ------------------------------------------------------------------------
   * POST /api/discovery/jobs/:id/retry — retry a FINISHED job.
   * ---------------------------------------------------------------------- */
  app.post(
    DISCOVERY_JOB_RETRY_ROUTE,
    { preHandler: preHandlerWrite, ...writeRateLimit },
    async (req, reply) => {
      const { id } = req.params as { id?: string };
      if (!id || !UUID_RE.test(id)) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid job id' } });
      }
      const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id)).limit(1);
      if (!job) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Discovery job not found' } });
      }
      if (!FINAL_STATUSES.has(job.status)) {
        return reply.code(409).send({
          error: {
            code: 'invalid_state',
            message: `Discovery job is ${job.status}; only finished jobs (COMPLETED/PARTIAL/FAILED/CANCELED) can be retried`,
          },
        });
      }
      const discoveryCfg = await settings.getDiscoveryConfig();
      if (job.attempts >= discoveryCfg.max_attempts) {
        return reply.code(409).send({
          error: {
            code: 'max_attempts',
            message: `Discovery job has reached max attempts (${discoveryCfg.max_attempts})`,
          },
        });
      }

      const actor = actorFrom(req.auth);
      await writeAudit({
        ...actor,
        action: 'DISCOVERY_JOB_RETRIED',
        entityType: 'discovery_job',
        entityId: id,
        before: { attempts: job.attempts, status: job.status },
        after: { attempts: job.attempts + 1, status: 'PENDING' },
        source: 'discovery',
      });

      // Background retry — retryDiscoveryJob re-validates, bumps attempts,
      // resets progress, and runs. Never awaited by the request.
      void retryDiscoveryJob(id).then(
        () => undefined,
        (err: unknown) => {
          app.log.error({ err, jobId: id }, 'background discovery retry failed');
        },
      );

      return reply.code(202).send({
        job: toJobJson(job),
        message: `retry accepted (attempt ${job.attempts + 1} of ${discoveryCfg.max_attempts}); the run is asynchronous`,
      });
    },
  );

  /* ------------------------------------------------------------------------
   * POST /api/discovery/jobs/:id/cancel — cancel an active job.
   * ---------------------------------------------------------------------- */
  app.post(
    DISCOVERY_JOB_CANCEL_ROUTE,
    { preHandler: preHandlerWrite, ...writeRateLimit },
    async (req, reply) => {
      const { id } = req.params as { id?: string };
      if (!id || !UUID_RE.test(id)) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid job id' } });
      }
      const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id)).limit(1);
      if (!job) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Discovery job not found' } });
      }
      if (FINAL_STATUSES.has(job.status)) {
        return reply.code(409).send({
          error: { code: 'invalid_state', message: `Discovery job is already finished (${job.status})` },
        });
      }

      const actor = actorFrom(req.auth);

      // Live run in THIS process → flip the cancel token; the runner stops
      // between batches and marks the job CANCELED itself.
      const token = activeTokens.get(id);
      if (token) {
        token.cancelled = true;
        await writeAudit({
          ...actor,
          action: 'DISCOVERY_JOB_CANCELED',
          entityType: 'discovery_job',
          entityId: id,
          before: { status: job.status },
          after: { cancel_requested: true },
          source: 'discovery',
        });
        return reply.code(200).send({
          job: toJobJson(job),
          cancel_requested: true,
          message: 'cancel requested; the runner stops between batches and marks the job CANCELED',
        });
      }

      // PENDING with no live runner → nothing will execute it; mark CANCELED
      // directly (a runner that was about to start hits the PENDING gate).
      if (job.status === 'PENDING') {
        const now = new Date();
        await db
          .update(discoveryJobs)
          .set({ status: 'CANCELED', cancelled_at: now, finished_at: now })
          .where(eq(discoveryJobs.id, id));
        await writeAudit({
          ...actor,
          action: 'DISCOVERY_JOB_CANCELED',
          entityType: 'discovery_job',
          entityId: id,
          before: { status: 'PENDING' },
          after: { status: 'CANCELED', via: 'direct' },
          source: 'discovery',
        });
        const [updated] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id)).limit(1);
        return reply.code(200).send({ job: toJobJson(updated ?? job) });
      }

      // RUNNING but no runner in this process (stale row after a restart) —
      // honest refusal: nothing here can cooperatively stop it.
      return reply.code(409).send({
        error: {
          code: 'no_active_runner',
          message: 'job is RUNNING but no runner in this process owns it; cannot cancel cooperatively',
        },
      });
    },
  );

  /* ------------------------------------------------------------------------
   * GET /api/discovery/jobs — list jobs, most recent first.
   * ---------------------------------------------------------------------- */
  app.get(DISCOVERY_JOBS_ROUTE, { preHandler: preHandlerRead }, async (req, reply) => {
    const rawLimit = (req.query as { limit?: unknown }).limit;
    let limit =
      typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? parseInt(rawLimit, 10) : 50;
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.min(Math.max(limit, 1), 200);

    const rows = await db
      .select()
      .from(discoveryJobs)
      .orderBy(desc(discoveryJobs.created_at))
      .limit(limit);
    return reply.code(200).send({ jobs: rows.map(toJobJson), count: rows.length });
  });

  /* ------------------------------------------------------------------------
   * GET /api/discovery/jobs/:id — one job + errors + ingested estimate.
   * ---------------------------------------------------------------------- */
  app.get(DISCOVERY_JOB_BY_ID_ROUTE, { preHandler: preHandlerRead }, async (req, reply) => {
    const { id } = req.params as { id?: string };
    if (!id || !UUID_RE.test(id)) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid job id' } });
    }
    const [job] = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, id)).limit(1);
    if (!job) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Discovery job not found' } });
    }

    const errors = await db
      .select()
      .from(discoveryJobErrors)
      .where(eq(discoveryJobErrors.job_id, id))
      .orderBy(asc(discoveryJobErrors.created_at))
      .limit(200);
    const [errorsTotalRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(discoveryJobErrors)
      .where(eq(discoveryJobErrors.job_id, id));

    // Businesses ingested "by this job" — the runner does not tag businesses
    // with job ids (out of scope), so this is an honest window estimate:
    // businesses matching the job target created between the job's start (or
    // creation) and its finish (or now). The note says exactly that.
    const from = job.started_at ?? job.created_at;
    const to = job.finished_at ?? new Date();
    const matchWhere = and(
      eq(businesses.industry, job.industry),
      eq(businesses.state, job.state),
      job.city ? sql`lower(${businesses.city}) = ${job.city.toLowerCase()}` : undefined,
      gte(businesses.created_at, from),
      lte(businesses.created_at, to),
    );
    const bySource = await db
      .select({ source: businesses.source, count: sql<number>`count(*)::int` })
      .from(businesses)
      .where(matchWhere)
      .groupBy(businesses.source);
    const total = bySource.reduce((acc, r) => acc + r.count, 0);

    return reply.code(200).send({
      job: toJobJson(job),
      errors: errors.map((e) => ({
        id: e.id,
        business_name: e.business_name,
        message: e.message,
        retryable: e.retryable,
        category: e.category,
        created_at: e.created_at.toISOString(),
      })),
      errors_total: errorsTotalRow?.n ?? errors.length,
      businesses: {
        total,
        by_source: bySource,
        window: { from: from.toISOString(), to: to.toISOString() },
        matched_on: { industry: job.industry, state: job.state, ...(job.city ? { city: job.city } : {}) },
        note:
          'estimate: the runner does not tag businesses with job ids; this counts businesses matching the job target created within the job run window',
      },
    });
  });
}

/**
 * Load a job's exception rows (used by tests + the admin detail view helpers).
 * Kept tiny and read-only — exceptions for a job are written by the runner.
 */
export async function getJobExceptions(jobId: string) {
  return db
    .select()
    .from(exceptions)
    .where(and(eq(exceptions.entity_type, 'discovery_job'), eq(exceptions.entity_id, jobId)));
}
