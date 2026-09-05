/**
 * Website analysis API — thin authenticated Fastify routes over the website
 * analysis service (the fetch + analyze core).
 *
 *   POST /api/businesses/:businessId/analyze-website   analysis (force=true)
 *   POST /api/businesses/:businessId/reanalyze-website alias (force=true)
 *
 * Both run analyzeBusinessWebsite with forceReanalyze=true: an explicit owner
 * call always re-fetches and re-runs the analysis. The routes stay thin — all
 * logic lives in the service; 400/401/403/404/500 handling here mirrors
 * src/discovery/routes.ts.
 *
 * Auth model (mirrors src/config/routes.ts and src/discovery/routes.ts):
 *   - owner JWT or ADMIN-scope API key (POST = write);
 *   - 401 unauthenticated, 403 insufficient scope.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { businesses } from '../db/schema';
import {
  authenticatePreHandler,
  requireScopePreHandler,
} from '../auth/middleware';
import type { AuthConfig } from '../auth/config';
import { analyzeBusinessWebsite } from './website-analysis-service';

/** Route constants (exported for tests + README). */
export const ANALYZE_WEBSITE_ROUTE = '/api/businesses/:businessId/analyze-website';
export const REANALYZE_WEBSITE_ROUTE = '/api/businesses/:businessId/reanalyze-website';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RegisterWebsiteAnalysisRoutesOptions {
  authConfig?: AuthConfig;
  /** Per-IP limit for analysis POSTs per minute (default 30). */
  writeRateLimitMax?: number;
}

/**
 * Register the website-analysis API on an existing Fastify app. The app built
 * by buildAuthApp() already registers @fastify/rate-limit globally; the
 * per-route limit below is inert when it is not registered (same as the config
 * routes).
 */
export async function registerWebsiteAnalysisRoutes(
  app: FastifyInstance,
  opts: RegisterWebsiteAnalysisRoutesOptions = {},
): Promise<void> {
  const cfg = opts.authConfig ?? (await import('../auth/config')).loadAuthConfig();
  const preHandlerWrite: NonNullable<Parameters<typeof app.post>[1]>['preHandler'] = [
    authenticatePreHandler(cfg),
    requireScopePreHandler('admin'), // owner JWT passes; API keys need admin scope
  ];
  const writeRateLimit = {
    config: { rateLimit: { max: opts.writeRateLimitMax ?? 30, timeWindow: '1 minute' } },
  } as const;

  /** Shared handler for both routes (analyze = reanalyze for an explicit call). */
  const run = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { businessId } = req.params as { businessId?: string };
    if (!businessId || !UUID_RE.test(businessId)) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid business id' } });
    }
    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!business) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Business not found' } });
    }
    try {
      // Explicit owner call → always force a fresh analysis.
      const result = await analyzeBusinessWebsite(businessId, { forceReanalyze: true });
      return reply.code(result.failure ? 502 : 200).send({ result });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: { code: 'internal_error', message: 'website analysis failed unexpectedly' } });
    }
  };

  app.post(ANALYZE_WEBSITE_ROUTE, { preHandler: preHandlerWrite, ...writeRateLimit }, run);
  app.post(REANALYZE_WEBSITE_ROUTE, { preHandler: preHandlerWrite, ...writeRateLimit }, run);
}