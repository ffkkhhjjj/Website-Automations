/**
 * Dashboard API + page routes.
 *
 *   GET /api/dashboard/overview   owner JWT or any API key (read scope) → JSON
 *   GET /dashboard                owner-only page → static HTML shell
 *   GET /dashboard/assets/*       static CSS/JS served from src/public
 *   GET /dashboard/auth/login     minimal login page (owner email + password)
 *
 * The page is a thin, dependency-free shell: it fetches the overview JSON with
 * the owner's JWT (held in localStorage only for the page) and renders the
 * 30-second view. The API stays the platform's first-class surface for later
 * automation; the HTML is just one client of it.
 *
 * Auth model:
 *  - /dashboard and /dashboard/assets are PUBLIC shells (no secrets served;
 *    the JSON payload is only rendered after a successful owner login).
 *  - /api/dashboard/overview requires credentials: owner JWT (Bearer) or any
 *    API key (read scope is inherent to API keys).
 */
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOverview } from './service';
import { authenticatePreHandler } from '../auth/middleware';
import type { AuthConfig } from '../auth/config';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Route prefixes (exported for tests + README). */
export const DASHBOARD_API_ROUTE = '/api/dashboard/overview';
export const DASHBOARD_PAGE_ROUTE = '/dashboard';

export interface RegisterDashboardRoutesOptions {
  authConfig?: AuthConfig;
  /** Root of the static dashboard assets (defaults to src/public). */
  publicDir?: string;
}

/**
 * Register dashboard routes on an existing Fastify app (the app built by
 * buildAuthApp() already registered @fastify/rate-limit globally).
 */
export async function registerDashboardRoutes(
  app: FastifyInstance,
  opts: RegisterDashboardRoutesOptions = {},
): Promise<void> {
  const cfg = opts.authConfig ?? (await import('../auth/config')).loadAuthConfig();
  const publicDir = opts.publicDir ?? join(HERE, '..', 'public');

  // --- API: full owner overview (JSON) -------------------------------------
  app.get(
    DASHBOARD_API_ROUTE,
    { preHandler: [authenticatePreHandler(cfg)] },
    async (_req, reply) => {
      try {
        const overview = await getOverview();
        return reply.code(200).send(overview);
      } catch (e) {
        _req.log.error(e);
        return reply
          .code(500)
          .send({ error: { code: 'internal_error', message: 'Failed to build dashboard overview' } });
      }
    },
  );

  // --- Static assets (CSS/JS/images) — public, no business data -------------
  app.register(async (staticApp) => {
    const fastifyStatic = (await import('@fastify/static')).default;
    await staticApp.register(fastifyStatic, {
      root: publicDir,
      prefix: '/dashboard/assets/',
      decorateReply: false,
    });
  });

  // --- Page shell ------------------------------------------------------------
  app.get(DASHBOARD_PAGE_ROUTE, async (_req, reply) => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(join(publicDir, 'dashboard.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // --- Minimal owner login page (per brief: reuse login flow via the API) ----
  app.get('/dashboard/auth/login', async (_req, reply) => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(join(publicDir, 'login.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });
}