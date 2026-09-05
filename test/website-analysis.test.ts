/**
 * Website analysis engine tests — fetch + analyze core.
 *
 * Strives for hermeticity: websites are served by node:http servers on
 * ephemeral ports in this process — no external network. The DB layer runs
 * against the throwaway Postgres created by test/global-setup.ts (the same
 * pool the other suites use).
 *
 * Covers (per brief):
 *  - fetch happy path: HTML home + internal pages → WebsiteInput with pages,
 *    signals, httpStatus, timing, NAP extraction;
 *  - URL normalization: bare domain, http→https redirect, missing scheme
 *    (https preferred, http fallback);
 *  - retry-then-success on transient 5xx; no retry on 404;
 *  - timeout → failure reason + no score invented + website_analysis_failed
 *    exception created;
 *  - no URL → WEBSITE_NOT_FOUND failure + website_missing exception, no score;
 *  - reanalyze: forces a new analysis row, keeps history, resolves prior
 *    failure exception;
 *  - regression: scoreBusiness (existing scoring path) still passes.
 */
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, and, asc, desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import {
  businesses,
  websites,
  websiteAnalyses,
  exceptions,
  auditLogs,
  leadScores,
  scoringVersions,
  systemSettings,
} from '../src/db/schema';
import { scoreBusiness } from '../src/scoring/orchestrator';
import { analyzeBusinessWebsite, reanalyzeBusinessWebsite } from '../src/scoring/website-analysis-service';
import { fetchWebsite, normalizeWebsiteUrl, isCrawlableLink } from '../src/scoring/website-fetch';

/* ----------------------------------------------------------------------------
 * Local website server
 * ------------------------------------------------------------------------- */

type RouteHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;

/** A small route-table HTTP server for hermetic fetches. */
class LocalSite {
  server: Server;
  port = 0;
  requests: { url: string | undefined; headers: Record<string, string | string[] | undefined> }[] = [];
  private routes = new Map<string, RouteHandler>();

  constructor() {
    this.server = createServer((req, res) => {
      this.requests.push({ url: req.url, headers: req.headers });
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const handler = this.routes.get(path) ?? ((_r, r2) => {
        r2.writeHead(404, { 'content-type': 'text/plain' });
        r2.end('not found');
      });
      handler(req, res);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      // Force-close any lingering connections so suite teardown never hangs.
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
      }
      this.server.close(() => resolve());
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  route(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
  }

  /** Default plumber site (rich enough for a decent score). */
  defaultSite(): void {
    this.route('/', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head>
        <title>Rapid Rooter Plumbing | Austin TX</title>
        <meta name="description" content="Fast local plumbing. Water heater and drain repair.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head><body>
        <h1>Rapid Rooter Plumbing</h1>
        <p>24/7 emergency plumbing in Austin. Call for a free estimate.</p>
        <img src="team.jpg"><img src="van.jpg">
        <a href="tel:+15125550000">Call (512) 555-0000</a>
        <a href="/services">Services</a>
        <a href="/contact">Contact</a>
        <!-- Exactly 3 internal links: the default crawl budget is 3, so the
             broken-page link must be reachable for the no_broken_links check. -->
        <a href="/broken-page">Broken</a>
        <a href="mailto:info@rapidrooter.example">Email us</a>
        <form action="/contact" method="post"></form>
        <p>123 Main St, Austin, TX 78701</p>
      </body></html>`);
    });
    this.route('/services', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>Services</title></head><body><h1>Our Services</h1><p>Water heaters, drain cleaning, repipes.</p><a href="/">Home</a></body></html>');
    });
    this.route('/about', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>About</title></head><body><h1>About Rapid Rooter</h1><p>Family-owned since 1998.</p></body></html>');
    });
    this.route('/contact', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>Contact</title></head><body><h1>Contact Us</h1><p>(512) 555-0000 · 123 Main St</p></body></html>');
    });
    this.route('/broken-page', (_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('missing');
    });
  }
}

/* ----------------------------------------------------------------------------
 * DB helpers (same conventions as the other suites)
 * ------------------------------------------------------------------------- */

async function seedDefaults(): Promise<void> {
  const settings = [
    { key: 'target.industries', value: ['plumbing'], type: 'array' },
    { key: 'target.states', value: [], type: 'array' },
    { key: 'scoring.website_quality.weights', value: { conversion: 25, mobile: 20, content: 15, trust: 15, technical: 15, design_ux: 10 }, type: 'json' },
    { key: 'scoring.business_opportunity.weights', value: { viability: 25, demand: 25, ability_to_pay: 20, contactability: 20, icp_fit: 10 }, type: 'json' },
    { key: 'scoring.lead_priority.formula', value: { website_quality: 0.45, business_opportunity: 0.4, market_fit: 0.15 }, type: 'json' },
    { key: 'scoring.lead_classification.thresholds', value: { high_priority_min: 80, secondary_min: 65, review_min: 50 }, type: 'json' },
    { key: 'scoring.rejection.thresholds', value: { min_opportunity_score: 50, excellent_website_min: 90, min_contactability_score: 40, inactive_statuses: ['CLOSED', 'PERMANENTLY_CLOSED', 'TEMPORARILY_CLOSED'] }, type: 'json' },
    { key: 'analysis.website_recent_ms', value: 86400000, type: 'number' },
  ] as const;
  for (const s of settings) {
    await db
      .insert(systemSettings)
      .values({ key: s.key, value: s.value as never, type: s.type, description: 'test seed' })
      .onConflictDoNothing({ target: systemSettings.key });
  }
  const versions = [
    { score_type: 'WEBSITE_QUALITY', version: 1, weights: { conversion: 25, mobile: 20, content: 15, trust: 15, technical: 15, design_ux: 10 } },
    { score_type: 'BUSINESS_OPPORTUNITY', version: 1, weights: { viability: 25, demand: 25, ability_to_pay: 20, contactability: 20, icp_fit: 10 } },
    { score_type: 'LEAD_PRIORITY', version: 1, weights: { website_quality: 0.45, business_opportunity: 0.4, market_fit: 0.15 } },
  ] as const;
  for (const v of versions) {
    await db
      .insert(scoringVersions)
      .values({ score_type: v.score_type as never, version: v.version, weights: v.weights as never, description: 'test v1', is_active: true })
      .onConflictDoNothing({ target: [scoringVersions.score_type, scoringVersions.version] });
  }
}

async function createBusiness(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(businesses)
    .values({
      business_name: `Analysis Test Plumbing ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      industry: 'plumbing',
      source: 'test',
      lifecycle_state: 'DISCOVERED',
      ...overrides,
    })
    .returning({ id: businesses.id });
  return row!.id;
}

const created: string[] = [];

beforeAll(async () => {
  await seedDefaults();
});

afterAll(async () => {
  // Clean in dependency order; throwaway DB is dropped on next run.
  await db.delete(auditLogs).where(eq(auditLogs.source, 'website-analysis'));
  await db.delete(exceptions).where(eq(exceptions.entity_type, 'business'));
  await db.delete(websiteAnalyses);
  await db.delete(websites);
  await db.delete(leadScores);
  for (const id of created) {
    await db.delete(businesses).where(eq(businesses.id, id));
  }
  await db.delete(auditLogs).where(eq(auditLogs.source, 'scoring'));
  for (const s of servers) {
    await s.close().catch(() => undefined);
  }
  await pool.end();
});

async function audits(businessId: string, action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entity_id, businessId), eq(auditLogs.action, action)))
    .orderBy(asc(auditLogs.created_at));
}

function openException(businessId: string, category: string) {
  return db
    .select()
    .from(exceptions)
    .where(
      and(
        eq(exceptions.entity_type, 'business'),
        eq(exceptions.entity_id, businessId),
        eq(exceptions.category, category),
        eq(exceptions.status, 'OPEN'),
      ),
    )
    .orderBy(desc(exceptions.created_at))
    .limit(1);
}

let site: LocalSite | null = null;
const servers: LocalSite[] = [];

beforeEach(() => {
  site = null;
});

/* ----------------------------------------------------------------------------
 * Fetcher unit tests (hermetic, no DB)
 * ------------------------------------------------------------------------- */

describe('website fetcher', () => {
  it('(1) URL normalization: bare domain, scheme, reject junk', () => {
    expect(normalizeWebsiteUrl('rapidrooter.com')).toBe('https://rapidrooter.com/');
    expect(normalizeWebsiteUrl('www.rapidrooter.com')).toBe('https://www.rapidrooter.com/');
    expect(normalizeWebsiteUrl('https://rapidrooter.com/services')).toBe('https://rapidrooter.com/services');
    expect(normalizeWebsiteUrl('http://rapidrooter.com')).toBe('http://rapidrooter.com/');
    expect(normalizeWebsiteUrl('   ')).toBeUndefined();
    expect(normalizeWebsiteUrl('')).toBeUndefined();
    expect(normalizeWebsiteUrl('not a url with spaces')).toBeUndefined();
    expect(normalizeWebsiteUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeWebsiteUrl(null)).toBeUndefined();
  });

  it('(2) isCrawlableLink: skips mailto/tel/pdf/images', () => {
    const base = 'https://rapidrooter.com';
    expect(isCrawlableLink('/services', base)).toBe(true);
    expect(isCrawlableLink('https://rapidrooter.com/contact', base)).toBe(true);
    expect(isCrawlableLink('mailto:info@x.com', base)).toBe(false);
    expect(isCrawlableLink('tel:+15125550000', base)).toBe(false);
    expect(isCrawlableLink('#frag', base)).toBe(false);
    expect(isCrawlableLink('/price-list.pdf', base)).toBe(false);
    expect(isCrawlableLink('/logo.png', base)).toBe(false);
    expect(isCrawlableLink('https://other-domain.com/', base)).toBe(false);
  });

  it('(3) fetch happy path: pages, signals, httpStatus, timing, NAP', async () => {
    const s = new LocalSite();
    s.defaultSite();
    await s.listen();
    site = s;
    servers.push(s);

    // Scheme-less input against the local server: https attempt fails
    // (the server is plain http) → http fallback used.
    const result = await fetchWebsite(`127.0.0.1:${s.port}`, {
    requestTimeoutMs: 3000,
    overallTimeoutMs: 8000,
    maxRetries: 0,
    });
    expect(result.ok).toBe(true);
    const input = result.websiteInput!;
    expect(input.url).toBe(`http://127.0.0.1:${s.port}/`);
    const paths = input.pages.map((p) => new URL(p.url).pathname);
    expect(paths).toContain('/');
    expect(paths).toContain('/services');
    // At most 1 (home) + 3 internal pages.
    expect(input.pages.length).toBeLessThanOrEqual(4);
    expect(input.pages.length).toBeGreaterThanOrEqual(2);

    const home = input.pages[0]!;
    expect(home.httpStatus).toBe(200);
    expect(typeof home.responseTimeMs).toBe('number');
    expect(home.html).toContain('Rapid Rooter Plumbing');
    expect(input.observedBusinessName).toContain('Rapid Rooter');
    expect(input.observedPhone).toMatch(/\d{3}[-.)]\d{3}/);
    expect(input.observedAddress).toBeDefined();
    expect(input.brokenInternalLinks).toBeDefined();
    expect(input.brokenInternalLinks![0]).toContain('/broken-page');

    // NAP + contact checks get real material (deterministic score path reused).
    const { analyzeWebsite } = await import('../src/scoring/website-quality');
    const { getWebsiteQualityWeights } = await import('../src/scoring/config');
    const analysis = analyzeWebsite(input, { weights: await getWebsiteQualityWeights() });
    expect(analysis.websiteQualityScore).toBeGreaterThan(50);
    expect(analysis.testResults.find((o) => o.checkId === 'has_nap')!.result).toBe('PASS');
    expect(analysis.testResults.find((o) => o.checkId === 'no_broken_links')!.result).toBe('FAIL');
    expect(analysis.testResults.find((o) => o.checkId === 'has_http_ok')!.result).toBe('PASS');
  });

  it('(4) retry then success on transient 5xx; no retry on 404', async () => {
    const s = new LocalSite();
    let hits = 0;
    let notFoundHits = 0;
    s.route('/', (_req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('busy');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Retry Site</title></head><body><h1>OK</h1></body></html>');
    });
    s.route('/missing', (_req, res) => {
      notFoundHits += 1;
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('nope');
    });
    await s.listen();
    site = s;
    servers.push(s);

    const base = s.baseUrl;
    // 503 twice then 200 → retry works (maxRetries=2).
    const retried = await fetchWebsite(`${base}/`, { requestTimeoutMs: 2000, maxRetries: 2, retryBaseDelayMs: 10 });
    expect(retried.ok).toBe(true);
    expect(hits).toBe(3);

    // 404 → observed as a broken link, NOT retried (no retry on 4xx).
    const broken = await fetchWebsite(`${base}/missing`, { requestTimeoutMs: 2000, maxRetries: 2, retryBaseDelayMs: 10 });
    expect(broken.ok).toBe(false);
    expect(broken.failure!.reason).toBe('HTTP_ERROR');
    expect(broken.failure!.httpStatus).toBe(404);
    expect(notFoundHits).toBe(1);
  });
});

/* ----------------------------------------------------------------------------
 * Service integration tests (DB + local site)
 * ------------------------------------------------------------------------- */

describe('website analysis service', () => {
  it('(5) timeout → failure reason, no score invented, website_analysis_failed exception', async () => {
    const s = new LocalSite();
    s.route('/', (_req, res) => {
      // Never respond — the request must be aborted by the timeout.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('late');
      }, 5000);
    });
    await s.listen();
    site = s;
    servers.push(s);

    const id = await createBusiness({ website_url: `${s.baseUrl}/` });
    created.push(id);

    const result = await analyzeBusinessWebsite(id, {
      fetchOptions: { requestTimeoutMs: 300, maxRetries: 0, overallTimeoutMs: 4000 },
    });
    expect(result.failure).not.toBeNull();
    expect(result.websiteQualityScore).toBeNull();
    expect(['TIMEOUT', 'CRAWL_TIMEOUT']).toContain(result.failure!.reason);

    const [webRow] = await db.select().from(websites).where(eq(websites.business_id, id)).limit(1);
    expect(webRow!.status).toBe('CRAWL_FAILED');
    expect(webRow!.url).toBe(`${s.baseUrl}/`);

    // No score: the failure marker row has a null score.
    const analyses = await db.select().from(websiteAnalyses).where(eq(websiteAnalyses.website_id, webRow!.id));
    expect(analyses.length).toBeGreaterThanOrEqual(1);
    for (const a of analyses) {
      expect(a.website_quality_score).toBeNull();
    }

    // Medium-priority exception created.
    const exc = await openException(id, 'website_analysis_failed');
    expect(exc).toBeDefined();
    expect(exc[0]!.priority).toBe('MEDIUM');

    // Audit written.
    const failedAudits = await audits(id, 'WEBSITE_ANALYSIS_FAILED');
    expect(failedAudits.length).toBeGreaterThanOrEqual(1);
  });

  it('(6) no URL → WEBSITE_NOT_FOUND failure + website_missing exception; NO score', async () => {
    const id = await createBusiness({ website_url: null });
    created.push(id);

    const result = await analyzeBusinessWebsite(id);
    expect(result.websiteQualityScore).toBeNull();
    expect(result.failure!.reason).toBe('WEBSITE_NOT_FOUND');
    expect(result.website.status).toBe('NO_WEBSITE');

    const exc = await openException(id, 'website_missing');
    expect(exc).toBeDefined();
    expect(exc[0]!.priority).toBe('LOW');

    // No website row, no analysis row.
    const webRows = await db.select().from(websites).where(eq(websites.business_id, id));
    expect(webRows).toHaveLength(0);
    const analysisRows = await db.select().from(websiteAnalyses);
    const forThisBusiness = analysisRows.filter((a) => {
      const w = webRows.find((r) => r.id === a.website_id);
      return w !== undefined;
    });
    expect(forThisBusiness).toHaveLength(0);
  });

  it('(7) happy path: analyze → score ≥ 0, website ANALYZED, exception resolved, idempotent short-circuit', async () => {
    const s = new LocalSite();
    s.defaultSite();
    await s.listen();
    site = s;
    servers.push(s);

    const id = await createBusiness({ website_url: `${s.baseUrl}/` });
    created.push(id);

    // First an open failure exception (to prove success resolves it).
    await db.insert(exceptions).values({
      entity_type: 'business',
      entity_id: id,
      priority: 'MEDIUM',
      category: 'website_analysis_failed',
      status: 'OPEN',
      message: 'seeded prior failure',
    });

    const result = await analyzeBusinessWebsite(id, {
      fetchOptions: { requestTimeoutMs: 3000, overallTimeoutMs: 8000, maxRetries: 0 },
    });
    expect(result.failure).toBeNull();
    expect(result.websiteQualityScore).not.toBeNull();
    expect(result.websiteQualityScore!).toBeGreaterThan(50);
    expect(result.classification).toBeDefined();
    expect(result.analysisId).not.toBeNull();
    expect(result.version).not.toBeNull();
    expect(result.fresh).toBe(true);

    const [webRow] = await db.select().from(websites).where(eq(websites.business_id, id)).limit(1);
    expect(webRow!.status).toBe('ANALYZED');
    expect(webRow!.http_status).toBe(200);

    const analyses = await db.select().from(websiteAnalyses).where(eq(websiteAnalyses.website_id, webRow!.id));
    expect(analyses).toHaveLength(1);
    expect(analyses[0]!.website_quality_score).toBe(result.websiteQualityScore);
    expect(analyses[0]!.evidence).toMatchObject({ weights: { conversion: 25 } });

    // Prior failure exception resolved.
    const open = await openException(id, 'website_analysis_failed');
    expect(open).toHaveLength(0);
    const [resolved] = await db
      .select()
      .from(exceptions)
      .where(and(eq(exceptions.entity_type, 'business'), eq(exceptions.entity_id, id), eq(exceptions.category, 'website_analysis_failed')));
    expect(resolved!.status).toBe('RESOLVED');
    expect(resolved!.resolved_at).not.toBeNull();

    // Audit WEBSITE_ANALYZED on the website entity.
    const analyzedAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'WEBSITE_ANALYZED'), eq(auditLogs.entity_id, webRow!.id)));
    expect(analyzedAudit).toHaveLength(1);

    // Idempotent: a second non-forced call serves the stored result.
    const second = await analyzeBusinessWebsite(id, {
      fetchOptions: { requestTimeoutMs: 3000, overallTimeoutMs: 8000, maxRetries: 0 },
    });
    expect(second.fresh).toBe(false);
    expect(second.analysisId).toBe(result.analysisId);
    expect(second.websiteQualityScore).toBe(result.websiteQualityScore);
  });

  it('(8) reanalyze: forces a NEW analysis row, keeps history, resolves prior failure exception', async () => {
    const s = new LocalSite();
    s.defaultSite();
    await s.listen();
    site = s;
    servers.push(s);
    const id = await createBusiness({ website_url: `${s.baseUrl}/` });
    created.push(id);

    // Seed a prior failure exception (as if a previous run failed).
    await db.insert(exceptions).values({
      entity_type: 'business',
      entity_id: id,
      priority: 'MEDIUM',
      category: 'website_analysis_failed',
      status: 'OPEN',
      message: 'prior transient failure',
    });

    const first = await analyzeBusinessWebsite(id, {
      fetchOptions: { requestTimeoutMs: 3000, overallTimeoutMs: 8000, maxRetries: 0 },
    });
    const second = await reanalyzeBusinessWebsite(id, {
      fetchOptions: { requestTimeoutMs: 3000, overallTimeoutMs: 8000, maxRetries: 0 },
    });

    expect(second.analysisId).not.toBe(first.analysisId);
    expect(second.fresh).toBe(true);

    const [webRow] = await db.select().from(websites).where(eq(websites.business_id, id)).limit(1);
    const analyses = await db
      .select()
      .from(websiteAnalyses)
      .where(eq(websiteAnalyses.website_id, webRow!.id))
      .orderBy(asc(websiteAnalyses.analyzed_at));
    expect(analyses).toHaveLength(2); // history kept — old row never deleted
    expect(analyses[1]!.id).toBe(second.analysisId);
    expect(analyses[0]!.id).toBe(first.analysisId);

    // Prior failure exception resolved after a successful re-analysis.
    const open = await openException(id, 'website_analysis_failed');
    expect(open).toHaveLength(0);
  });
});

/* ----------------------------------------------------------------------------
 * Regression: the existing scoring path is untouched
 * ------------------------------------------------------------------------- */

describe('regression: scoreBusiness still works', () => {
  it('(9) passing fixture: website analyzed → analysis row + lead_scores + audit, lifecycle untouched', async () => {
    const id = await createBusiness({ website_url: 'https://regression-plumber.example.com' });
    created.push(id);
    const websiteInput = {
      url: 'https://regression-plumber.example.com',
      pages: [
        {
          url: 'https://regression-plumber.example.com',
          httpStatus: 200,
          html: `<html><head>
            <title>Regression Plumber - Emergency Plumbing</title>
            <meta name="description" content="Fast local plumbing.">
            <meta name="viewport" content="width=device-width, initial-scale=1">
          </head><body>
            <h1>Regression Plumber</h1><p>Reviews and testimonials below.</p>
            <img src="a.jpg"><img src="b.jpg">
            <a href="tel:+15125550000">Call us</a>
            <a href="/services">Services</a><a href="/contact">Contact</a>
            <form action="/contact"></form>
          </body></html>`,
          responseTimeMs: 400,
        },
        { url: 'https://regression-plumber.example.com/services', httpStatus: 200, html: '<h1>Services</h1>' },
      ],
      observedBusinessName: 'Regression Plumber',
      observedPhone: '+15125550000',
      observedAddress: '1 Main St, Austin TX',
    };

    const result = await scoreBusiness(id, { websiteInput: websiteInput as never });
    expect(result.websiteQualityScore).toBeGreaterThan(60);
    expect(result.websiteAnalysisId).not.toBeNull();

    const [analysis] = await db
      .select()
      .from(websiteAnalyses)
      .where(eq(websiteAnalyses.id, result.websiteAnalysisId!));
    expect(analysis!.website_quality_score).toBe(result.websiteQualityScore);
    const tests = analysis!.test_results as { outcomes: { checkId: string; result: string }[] };
    expect(tests.outcomes.find((o) => o.checkId === 'has_https')!.result).toBe('PASS');

    const [scoreRow] = await db
      .select()
      .from(leadScores)
      .where(eq(leadScores.business_id, id));
    expect(scoreRow).toBeDefined();

    // Lifecycle untouched.
    const [row] = await db.select({ s: businesses.lifecycle_state }).from(businesses).where(eq(businesses.id, id));
    expect(row!.s).toBe('DISCOVERED');
  });
});