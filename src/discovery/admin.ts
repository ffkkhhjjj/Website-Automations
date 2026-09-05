/**
 * Discovery admin — page + static assets (brief 8B).
 *
 *   GET /admin/discovery            page shell (public HTML, like /dashboard)
 *   GET /admin/assets/discovery.css discovery-specific styles
 *   GET /admin/assets/discovery.js  dependency-free client (fetches the API)
 *
 * The page is a thin shell over the discovery API (owner JWT from the shared
 * login flow, held in localStorage only for the page). All business data flows
 * through the authenticated /api/discovery/* endpoints — the HTML serves no
 * secrets. Mirrors the dashboard page/asset pattern (src/dashboard/routes.ts).
 */
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Route constants (exported for tests + README). */
export const DISCOVERY_PAGE_ROUTE = '/admin/discovery';

export interface RegisterDiscoveryAdminRoutesOptions {
  /** Root of the static admin assets (defaults to src/public). */
  publicDir?: string;
}

export async function registerDiscoveryAdminRoutes(
  app: FastifyInstance,
  opts: RegisterDiscoveryAdminRoutesOptions = {},
): Promise<void> {
  const publicDir = opts.publicDir ?? join(HERE, '..', 'public');

  // Static discovery assets (CSS/JS) — public shells, no business data.
  app.register(async (staticApp) => {
    const fastifyStatic = (await import('@fastify/static')).default;
    await staticApp.register(fastifyStatic, {
      root: publicDir,
      prefix: '/admin/assets/',
      decorateReply: false, // the dashboard already decorated reply.sendFile
    });
  });

  // Page shell — same ownership model as /dashboard (public HTML, data via API).
  app.get(DISCOVERY_PAGE_ROUTE, async (_req, reply) => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(join(publicDir, 'discovery.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
