/**
 * Integrations status API.
 *
 *   GET /api/integrations/status    owner JWT or ANY API key (read scope) → JSON
 *
 * Returns per-module honest state straight from the registry — provider
 * selection from system_settings, configured/requiresConfiguration/missingEnvVars
 * derived from env presence. It never mutates anything and never touches
 * businesses or lead lifecycle (read-only surface).
 *
 * Auth model mirrors the dashboard/config APIs: authenticatePreHandler accepts
 * an owner JWT or a Bearer API key (read scope is inherent to API keys); an
 * unauthenticated caller gets 401.
 */
import type { FastifyInstance } from 'fastify';
import { authenticatePreHandler } from '../auth/middleware';
import type { AuthConfig } from '../auth/config';
import { IntegrationRegistry } from './registry';

/** Route prefix (exported for tests + README). */
export const INTEGRATIONS_STATUS_ROUTE = '/api/integrations/status';

export interface RegisterIntegrationsRoutesOptions {
  authConfig?: AuthConfig;
  /** Registry to read status from (defaults to a fresh not-configured registry). */
  registry?: IntegrationRegistry;
}

/**
 * Register the integrations status route on an existing Fastify app (the app
 * built by buildAuthApp() already registered @fastify/rate-limit globally).
 */
export async function registerIntegrationsRoutes(
  app: FastifyInstance,
  opts: RegisterIntegrationsRoutesOptions = {},
): Promise<void> {
  const cfg = opts.authConfig ?? (await import('../auth/config')).loadAuthConfig();
  const registry = opts.registry ?? new IntegrationRegistry();

  app.get(
    INTEGRATIONS_STATUS_ROUTE,
    { preHandler: [authenticatePreHandler(cfg)] },
    async (_req, reply) => {
      return reply.code(200).send({
        modules: await registry.statusAll(),
        generatedAt: new Date().toISOString(),
      });
    },
  );
}