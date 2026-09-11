/**
 * Businesses API — read surface + one guarded lifecycle write for the owner console.
 *
 *   GET  /api/businesses                 owner JWT or any API key (read scope)
 *     query: page, per_page, search (name substring), phone, industry, city,
 *            state, lifecycle_state, sort (created_at|business_name|rating|
 *            review_count), order (asc|desc)
 *   GET  /api/businesses/:businessId     owner JWT or any API key (read scope)
 *   POST /api/businesses/:businessId/lifecycle   owner JWT or ADMIN-scope API key
 *     body: { to_state, reason? } — validated through the state machine
 *     (transition()); moves to REJECTED/DO_NOT_CONTACT go through reject()
 *     with recorded reasons and REQUIRE a reason string.
 *
 * Auth model mirrors the dashboard/config APIs: authenticatePreHandler accepts
 * an owner JWT or a Bearer API key (read scope is inherent to API keys); an
 * unauthenticated caller gets 401, a read-scope key on POST gets 403.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/client';
import { businesses } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
  authenticatePreHandler,
  requireScopePreHandler,
} from '../auth/middleware';
import type { AuthConfig } from '../auth/config';
import { listBusinesses, getBusinessDetail } from './service';
import { transition } from '../lifecycle/transition-service.js';
import { reject, resolveRejectTarget } from '../lifecycle/rejection-service.js';
import { legalTargets } from '../lifecycle/transitions.js';
import { isValidState } from '../lifecycle/helpers.js';
import type { LeadState } from '../lifecycle/types.js';
import { LeadLifecycleError, InvalidTransitionError, type RejectionReason } from '../lifecycle/types.js';

/** Route prefixes (exported for tests + README). */
export const BUSINESSES_ROUTE = '/api/businesses';
export const BUSINESS_BY_ID_ROUTE = '/api/businesses/:businessId';
export const BUSINESS_LIFECYCLE_ROUTE = '/api/businesses/:businessId/lifecycle';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All 10 rejection_reason enum values (schema-derived union, spelled out for validation). */
const REJECTION_REASONS: readonly RejectionReason[] = [
  'INACTIVE_BUSINESS',
  'NO_CONTACT_ROUTE',
  'OUTSIDE_ICP',
  'EXCELLENT_WEBSITE',
  'LOW_OPPORTUNITY',
  'OPT_OUT',
  'DO_NOT_CONTACT_REQUEST',
  'BAD_DATA',
  'DUPLICATE',
  'OTHER',
];

export interface RegisterBusinessesRoutesOptions {
  authConfig?: AuthConfig;
  /** Per-IP limit for lifecycle POSTs per minute (default 60). */
  writeRateLimitMax?: number;
}

export async function registerBusinessesRoutes(
  app: FastifyInstance,
  opts: RegisterBusinessesRoutesOptions = {},
): Promise<void> {
  const cfg = opts.authConfig ?? (await import('../auth/config')).loadAuthConfig();
  const preHandlerRead = [authenticatePreHandler(cfg)];
  const preHandlerWrite: NonNullable<Parameters<typeof app.post>[1]>['preHandler'] = [
    authenticatePreHandler(cfg),
    requireScopePreHandler('admin'), // owner JWT passes; API keys need admin scope
  ];
  const writeRateLimit = {
    config: { rateLimit: { max: opts.writeRateLimitMax ?? 60, timeWindow: '1 minute' } },
  } as const;

  /* ------------------------------------------------------------------------
   * GET /api/businesses — paginated, filtered, sortable list.
   * ---------------------------------------------------------------------- */
  app.get(BUSINESSES_ROUTE, { preHandler: preHandlerRead }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    try {
      const result = await listBusinesses({
        page: q.page,
        perPage: q.per_page ?? q.perPage,
        search: q.search,
        phone: q.phone,
        industry: q.industry,
        city: q.city,
        state: q.state,
        lifecycleState: q.lifecycle_state ?? q.lifecycleState,
        sort: q.sort,
        order: q.order,
      });
      return reply.code(200).send(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'invalid request';
      return reply.code(400).send({ error: { code: 'invalid_request', message } });
    }
  });

  /* ------------------------------------------------------------------------
   * GET /api/businesses/:businessId — full detail.
   * ---------------------------------------------------------------------- */
  app.get(BUSINESS_BY_ID_ROUTE, { preHandler: preHandlerRead }, async (req, reply) => {
    const { businessId } = req.params as { businessId?: string };
    if (!businessId || !UUID_RE.test(businessId)) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid business id' } });
    }
    const detail = await getBusinessDetail(businessId);
    if (!detail) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Business not found' } });
    }
    return reply.code(200).send({ business: detail });
  });

  /* ------------------------------------------------------------------------
   * POST /api/businesses/:businessId/lifecycle — guarded state transition.
   *
   * Body: { to_state, reason?, rejection_reasons? }
   *  - to_state must be a valid LeadState and a legal target from the current
   *    state (the transition map decides; anything else is 422 with the legal
   *    targets listed).
   *  - Moves into REJECTED/DO_NOT_CONTACT go through reject() and REQUIRE a
   *    non-empty reason string (the human note) plus optional explicit
   *    rejection_reasons[] (defaults to ['OTHER']); unknown reasons are 400.
   * ---------------------------------------------------------------------- */
  app.post(
    BUSINESS_LIFECYCLE_ROUTE,
    { preHandler: preHandlerWrite, ...writeRateLimit },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { businessId } = req.params as { businessId?: string };
      if (!businessId || !UUID_RE.test(businessId)) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid business id' } });
      }
      const body = (req.body ?? {}) as { to_state?: unknown; reason?: unknown; rejection_reasons?: unknown };
      const toRaw = typeof body.to_state === 'string' ? body.to_state.trim().toUpperCase() : '';
      if (!toRaw || !isValidState(toRaw)) {
        return reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: 'to_state must be a valid lifecycle state' } });
      }
      const toState = toRaw as LeadState;

      const reasonRaw = body.reason === undefined || body.reason === null ? null : String(body.reason).trim();
      const reason = reasonRaw && reasonRaw.length > 0 ? reasonRaw : null;

      const [business] = await db
        .select({ id: businesses.id, lifecycle_state: businesses.lifecycle_state })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      if (!business) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Business not found' } });
      }
      const fromState = business.lifecycle_state as LeadState;

      if (toState === fromState) {
        return reply.code(422).send({
          error: {
            code: 'already_in_state',
            message: `Business is already in state ${fromState}`,
            legalTargets: [...legalTargets(fromState)],
          },
        });
      }

      const principal = req.auth;
      const actor =
        principal.type === 'user'
          ? { type: 'USER' as const, id: principal.userId ?? null }
          : { type: 'API' as const, id: principal.apiKeyId ?? null };

      try {
        if (toState === 'REJECTED' || toState === 'DO_NOT_CONTACT') {
          // Rejection path: a human reason is required (no silent rejects).
          if (!reason) {
            return reply.code(400).send({
              error: {
                code: 'reason_required',
                message: 'a reason is required when moving to REJECTED/DO_NOT_CONTACT',
              },
            });
          }
          let reasons: RejectionReason[] = ['OTHER'];
          if (body.rejection_reasons !== undefined && body.rejection_reasons !== null) {
            if (!Array.isArray(body.rejection_reasons) || body.rejection_reasons.length === 0) {
              return reply.code(400).send({
                error: { code: 'invalid_request', message: 'rejection_reasons must be a non-empty array when provided' },
              });
            }
            const parsed: RejectionReason[] = [];
            for (const r of body.rejection_reasons) {
              const up = String(r).trim().toUpperCase();
              if (!(REJECTION_REASONS as readonly string[]).includes(up)) {
                return reply.code(400).send({
                  error: { code: 'invalid_request', message: `unknown rejection reason "${r}"` },
                });
              }
              parsed.push(up as RejectionReason);
            }
            reasons = parsed;
          }
          const resolved = resolveRejectTarget(reasons);
          if (resolved !== toState) {
            return reply.code(422).send({
              error: {
                code: 'rejection_target_mismatch',
                message: `reasons ${reasons.join(', ')} resolve to ${resolved}, not ${toState}`,
              },
            });
          }
          const result = await reject(businessId, { reasons, reason, actor });
          const detail = await getBusinessDetail(businessId);
          return reply.code(200).send({
            businessId,
            fromState,
            toState: result.toState,
            reasons: result.insertedReasons,
            lifecycleState: detail?.lifecycleState ?? result.toState,
            legalTransitions: detail?.legalTransitions ?? [],
          });
        }

        const newState = await transition(businessId, toState, { reason, actor });
        const detail = await getBusinessDetail(businessId);
        return reply.code(200).send({
          businessId,
          fromState,
          toState: newState,
          lifecycleState: detail?.lifecycleState ?? newState,
          legalTransitions: detail?.legalTransitions ?? [...legalTargets(newState)],
        });
      } catch (e) {
        if (e instanceof InvalidTransitionError) {
          return reply.code(422).send({
            error: {
              code: 'invalid_transition',
              message: e.message,
              legalTargets: [...e.legalTargets],
            },
          });
        }
        if (e instanceof LeadLifecycleError) {
          const status = e.code === 'BUSINESS_NOT_FOUND' ? 404 : 422;
          return reply.code(status).send({ error: { code: e.code.toLowerCase(), message: e.message } });
        }
        req.log.error(e);
        return reply.code(500).send({ error: { code: 'internal_error', message: 'lifecycle transition failed' } });
      }
    },
  );
}
