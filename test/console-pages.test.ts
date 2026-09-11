/**
 * Operating console page tests — the /console SPA shell (working-dashboard brief).
 *
 * The console is a static, dependency-free shell in src/public/ served by
 * src/dashboard/routes.ts:
 *   GET /console           → console.html shell
 *   GET /console/assets/*  → console.css / console.js
 *   GET /console/*         → SPA fallback (deep links like /console/leads,
 *                            /console/leads/:id re-serve the shell; the client
 *                            router renders the view, so hard refreshes work)
 *
 * The pages are public shells (like /dashboard and /admin/discovery): no
 * business data is served by the HTML; all payloads come from the
 * authenticated APIs. No auth is asserted here for the same reason the
 * dashboard/discovery page tests skip auth on their shells.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { users } from '../src/db/schema';
import { buildAuthApp } from '../src/auth/client';
import { hashPassword } from '../src/auth/password';
import { seedSystemSettings } from '../src/db/seed-settings';
import { registerDashboardRoutes, CONSOLE_PAGE_ROUTE } from '../src/dashboard/routes';

const ctx: { app: Awaited<ReturnType<typeof buildAuthApp>>; ownerEmail: string; ownerPassword: string } = {
  app: null as never,
  ownerEmail: '',
  ownerPassword: 'sTr0ng-P@ssw0rd-42!',
};

function get(path: string) {
  return ctx.app.inject({ method: 'GET', url: path });
}

beforeAll(async () => {
  await seedSystemSettings();
  ctx.ownerEmail = `console-owner-${Date.now()}@test.local`;
  const hash = await hashPassword(ctx.ownerPassword);
  await db.insert(users).values({ email: ctx.ownerEmail, password_hash: hash, role: 'OWNER' });
  ctx.app = await buildAuthApp({ registerRateLimit: false });
  await registerDashboardRoutes(ctx.app);
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, ctx.ownerEmail));
  await pool.end();
});

describe('console page shell', () => {
  it('GET /console serves the console shell (200 HTML)', async () => {
    const res = await get(CONSOLE_PAGE_ROUTE);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const body = res.body;
    expect(body).toContain('console.css');
    expect(body).toContain('console.js');
    // The persistent sidebar with the six console views.
    for (const view of ['Overview', 'Leads', 'Discovery', 'Exceptions', 'Settings', 'Integrations']) {
      expect(body).toContain(view);
    }
  });

  it('static console assets are served (css + js)', async () => {
    const css = await get('/console/assets/console.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');

    const js = await get('/console/assets/console.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    // The client calls the real endpoints — nothing fabricated.
    expect(js.body).toContain('/api/businesses');
    expect(js.body).toContain('/api/dashboard/overview');
    expect(js.body).toContain('/api/settings');
    expect(js.body).toContain('/api/integrations/status');
    expect(js.body).toContain('/api/discovery/jobs');
  });

  it('SPA deep links under /console/* re-serve the shell', async () => {
    // Leads list with the pre-filter query the Overview cards and Discovery
    // "View leads" links navigate to.
    const leads = await get('/console/leads?lifecycle_state=QUALIFIED&industry=plumbing');
    expect(leads.statusCode).toBe(200);
    expect(leads.headers['content-type']).toContain('text/html');
    expect(leads.body).toContain('console.js');

    // Lead detail deep link.
    const detail = await get('/console/leads/00000000-0000-0000-0000-000000000000');
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('console.js');

    // Other views.
    for (const p of ['/console/discovery', '/console/exceptions', '/console/settings', '/console/integrations']) {
      const res = await get(p);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('console.js');
    }
  });

  it('login page redirects to the console after auth', async () => {
    const login = await get('/dashboard/auth/login');
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('/console');
  });
});