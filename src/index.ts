/**
 * Local Growth Engine — app server entry.
 *
 * Bootstraps the owner account (idempotent), builds the Fastify app (auth
 * routes + config + dashboard + integrations + discovery API/admin), and
 * listens on PORT (env, default 3000).
 *
 * The discovery scheduler is wired here: disabled at
 * schedule_interval_minutes=0 (seeded default); only ticks when the owner
 * enables it in Settings.
 *
 * Local only: nothing is published or deployed from this entry. Keep src/auth/index.ts exports intact (this file adds to
 * the tree; it does not re-export).
 *
 * Usage: npm start   (loads .env via dotenv)
 */
import 'dotenv/config';
import { buildAuthApp } from './auth/client';
import { registerConfigRoutes, CONFIG_ROUTE_PREFIX } from './config/routes';
import { registerDashboardRoutes, DASHBOARD_API_ROUTE, DASHBOARD_PAGE_ROUTE } from './dashboard/routes';
import { registerIntegrationsRoutes, INTEGRATIONS_STATUS_ROUTE } from './integrations/routes';
import {
  registerDiscoveryRoutes,
  DISCOVERY_JOBS_ROUTE,
} from './discovery/routes';
import {
  registerDiscoveryAdminRoutes,
  DISCOVERY_PAGE_ROUTE,
} from './discovery/admin';
import {
  registerWebsiteAnalysisRoutes,
  ANALYZE_WEBSITE_ROUTE,
  REANALYZE_WEBSITE_ROUTE,
} from './scoring/routes';
import { DiscoveryScheduler } from './discovery/scheduler';
import { settings } from './config/singleton';
import { bootstrapOwner } from './auth/bootstrap-owner-fn';

async function main(): Promise<void> {
  // Idempotent owner bootstrap — safe to run on every start.
  const bootstrapResult = await bootstrapOwner();
  if (!bootstrapResult.ok) {
    // Missing/invalid env configuration is a hard start failure (mirrors the
    // auth bootstrap CLI); a pre-existing owner is fine (skipped).
    console.error(`[start] owner bootstrap failed: ${bootstrapResult.message}`);
    process.exit(1);
  }

  const app = await buildAuthApp({ registerRateLimit: true });

  // Configuration API (authenticated; settings reads/writes).
  await registerConfigRoutes(app);

  // Owner dashboard: API overview + page shell (brief 6).
  await registerDashboardRoutes(app);

  // External integrations: honest status surface (brief 7 — no fake providers).
  await registerIntegrationsRoutes(app);

  // Discovery API + admin page (brief 8B — wraps the merged discovery core).
  await registerDiscoveryRoutes(app);
  await registerDiscoveryAdminRoutes(app);

  // Website analysis API (fetch + analyze core — this brief).
  await registerWebsiteAnalysisRoutes(app);

  // Discovery scheduler (brief 8B wiring): DISABLED at
  // schedule_interval_minutes=0 (the seeded default) — nothing runs until the
  // owner enables it in Settings. Enabled → periodic ticks that create + run
  // jobs from the ICP targets, with the scheduler's own single-active-job guard.
  const discoveryCfg = await settings.getDiscoveryConfig();
  const scheduler = new DiscoveryScheduler();
  if (discoveryCfg.schedule_interval_minutes <= 0) {
    console.log(
      `[start] discovery scheduler: disabled (schedule_interval_minutes=0)`,
    );
  } else {
    scheduler.start();
    console.log(
      `[start] discovery scheduler: enabled (every ${discoveryCfg.schedule_interval_minutes} min)`,
    );
  }

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[start] Local Growth Engine API listening on :${port}`);
  console.log(
    `[start] routes: /auth/*  ${CONFIG_ROUTE_PREFIX} (GET), ${CONFIG_ROUTE_PREFIX}/:key (PUT)` +
      `  ${DASHBOARD_API_ROUTE} (GET)  ${DASHBOARD_PAGE_ROUTE} (GET)` +
      `  ${INTEGRATIONS_STATUS_ROUTE} (GET)` +
      `  ${DISCOVERY_JOBS_ROUTE} (GET/POST)  ${DISCOVERY_PAGE_ROUTE} (GET)` +
      `  ${ANALYZE_WEBSITE_ROUTE} (POST)  ${REANALYZE_WEBSITE_ROUTE} (POST)`,
  );
}

main().catch((err) => {
  console.error('[start] failed to start:', err);
  process.exit(1);
});