/**
 * Configuration API — authenticated Fastify routes over system_settings.
 *
 *   GET /api/settings            owner JWT or ANY API key (read scope)
 *   PUT /api/settings/:key       owner JWT or ADMIN-scope API key
 *
 * Every update: validate → persist (value + updated_at) → audit (action
 * SETTINGS_UPDATED, before/after JSONB) → return the updated row. Unknown keys
 * and invalid values return 400/404 with a typed error; unknown keys never
 * enter the DB. See src/config/validation.ts for the per-key schemas.
 *
 * Rate limiting: the auth app registers @fastify/rate-limit globally; this
 * plugin adds a tighter per-route limit on settings writes (PUT) so automation
 * cannot hammer the audit log. If this plugin is mounted on an app WITHOUT the
 * rate-limit plugin, the route config is inert (safe).
 */
import type { FastifyInstance } from 'fastify';
import { SettingsService, SettingsError, type UpdateSettingInput } from './service';
import {
  authenticatePreHandler,
  requireScopePreHandler,
  type AuthPrincipal,
} from '../auth/middleware';
import type { AuthConfig } from '../auth/config';
import { authErr, AuthError } from '../auth/tokens';

/** Route prefix. */
export const CONFIG_ROUTE_PREFIX = '/api/settings';

export interface RegisterConfigRoutesOptions {
  service?: SettingsService;
  authConfig?: AuthConfig;
  /** Per-IP limit for settings writes per minute (default 60). */
  writeRateLimitMax?: number;
}

/**
 * Register the config API on an existing Fastify app. The app built by
 * buildAuthApp() already registers @fastify/rate-limit, so PUT carries a
 * per-route limit instead of registering the plugin a second time.
 */
export async function registerConfigRoutes(
  app: FastifyInstance,
  opts: RegisterConfigRoutesOptions = {},
): Promise<void> {
  const service = opts.service ?? new SettingsService();
  const cfg = opts.authConfig ?? (await import('../auth/config')).loadAuthConfig();

  const preHandler = [authenticatePreHandler(cfg)];
  const preHandlerWrite: NonNullable<Parameters<typeof app.put>[1]>['preHandler'] = [
    authenticatePreHandler(cfg),
    requireScopePreHandler('admin'), // owner JWT passes; API keys need admin scope
  ] as const;

  /**
   * GET /api/settings — full list for any authenticated principal (owner JWT
   * or any API key: read scope is inherent to API keys).
   */
  app.get(
    CONFIG_ROUTE_PREFIX,
    { preHandler },
    async (_req, reply) => {
      const rows = await service.list();
      return reply.code(200).send({ settings: rows });
    },
  );

  /**
   * PUT /api/settings/:key — owner JWT or admin-scope API key.
   */
  app.put(
    `${CONFIG_ROUTE_PREFIX}/:key`,
    {
      preHandler: preHandlerWrite,
      config: { rateLimit: { max: opts.writeRateLimitMax ?? 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const rawKey = (req.params as { key?: string }).key ?? '';
      const body = (req.body ?? {}) as {
        value?: unknown;
        description?: unknown;
        is_feature_flag?: unknown;
      };
      const input: UpdateSettingInput = { value: body.value };
      if (body.description !== undefined) {
        if (typeof body.description !== 'string') {
          return reply.code(400).send({ error: { code: 'invalid_request', message: 'description must be a string' } });
        }
        input.description = body.description;
      }
      if (body.is_feature_flag !== undefined) {
        if (typeof body.is_feature_flag !== 'boolean') {
          return reply.code(400).send({ error: { code: 'invalid_request', message: 'is_feature_flag must be a boolean' } });
        }
        input.is_feature_flag = body.is_feature_flag;
      }

      const principal: AuthPrincipal = req.auth;
      const actor =
        principal.type === 'user'
          ? { type: 'USER' as const, id: principal.userId ?? null }
          : { type: 'API' as const, id: principal.apiKeyId ?? null };

      try {
        const { row } = await service.update(rawKey, input, actor);
        return reply.code(200).send({ setting: row });
      } catch (e) {
        if (e instanceof SettingsError) {
          const status = e.code === 'UNKNOWN_KEY' ? 404 : e.code === 'INVALID_KEY_NAME' ? 400 : 400;
          return reply
            .code(status)
            .send({ error: { code: 'invalid_setting', message: e.message } });
        }
        if (e instanceof AuthError) throw e;
        req.log.error(e);
        return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
      }
    },
  );
}

/** Typed error helper for the routes (kept here for parity with authErr). */
export function settingsErr(
  code: Parameters<typeof authErr>[0],
  message: string,
  statusCode?: number,
): AuthError {
  return authErr(code, message, statusCode);
}
export { AuthError };