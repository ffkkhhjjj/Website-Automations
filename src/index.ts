/**
 * Local Growth Engine — app server entry.
 *
 * Bootstraps the owner account (idempotent), builds the Fastify app (auth
 * routes + config routes), and listens on PORT (env, default 3000).
 *
 * Local only: nothing is published or deployed from this entry — the dashboard
 * brief builds on it. Keep src/auth/index.ts exports intact (this file adds to
 * the tree; it does not re-export).
 *
 * Usage: npm start   (loads .env via dotenv)
 */
import 'dotenv/config';
import { buildAuthApp } from './auth/client';
import { registerConfigRoutes, CONFIG_ROUTE_PREFIX } from './config/routes';
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

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[start] Local Growth Engine API listening on :${port}`);
  console.log(`[start] routes: /auth/*  ${CONFIG_ROUTE_PREFIX} (GET), ${CONFIG_ROUTE_PREFIX}/:key (PUT)`);
}

main().catch((err) => {
  console.error('[start] failed to start:', err);
  process.exit(1);
});