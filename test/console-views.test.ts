/**
 * Operating console view-render regression tests (fix/console-render-bug brief).
 *
 * The previous test only proved the shell served; nobody ever executed a view's
 * render, so every view silently failed with
 *   "Could not load this view: Cannot read properties of undefined (reading 'appendChild')"
 * Root cause: bootView(view, fn) invoked fn() WITHOUT the view argument, so the
 * bare render functions (renderOverview, renderLeads, renderDiscovery, ...)
 * received undefined and threw on their first view.appendChild().
 *
 * These tests EXECUTE the real src/public/console.js inside a minimal DOM shim
 * (node:vm — hermetic, no browser, no network, no DB) with fetch stubbed by
 * fixtures that mirror the REAL API response shapes returned by the backend
 * endpoints (/api/dashboard/overview, /api/businesses, /api/discovery/jobs,
 * /api/settings, /api/integrations/status). Every view must render its data
 * into #view and must never show the view-level error box.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CONSOLE_JS = readFileSync(fileURLToPath(new URL('../src/public/console.js', import.meta.url)), 'utf8');

/* ---------------------------------------------------------------------------
 * API fixtures — field names match the real backend payloads (verified against
 * GET /api/dashboard/overview, /api/businesses, /api/businesses/:id,
 * /api/discovery/jobs, /api/settings, /api/integrations/status).
 * ------------------------------------------------------------------------- */

const OVERVIEW_FIXTURE = {
  generatedAt: '2026-09-11T13:20:00.000Z',
  hotLeads: [
    {
      businessId: '11111111-1111-4111-8111-111111111111',
      businessName: 'Hot Plumber Co',
      city: 'Austin',
      state: 'TX',
      websiteUrl: 'https://hotplumber.example.com/',
      leadPriorityScore: 92.4,
      websiteQualityScore: 31,
      lifecycleState: 'HOT',
      latestReplySnippet: 'We would love a new site — how much?',
      intent: 'INTERESTED',
      confidence: 0.87,
      suggestedAction: 'High-priority: contact the owner now with the demo and pricing.',
      demoUrl: null,
    },
  ],
  counts: {
    leadsFound: 44,
    leadsQualified: 0,
    demosCreated: 0,
    emailsSent: 0,
    replies: 0,
    interested: 0,
    sales: 0,
    revenue: 0,
    mrr: 0,
    demoViews: 0,
    emailBounces: 0,
    unsubscribes: 0,
    systemErrors: 0,
  },
  countsMeta: {
    revenue: { value: 0, wired: false, source: 'connected finance account (not connected)' },
    mrr: { value: 0, wired: false, source: 'billing pipeline (not wired)' },
    demoViews: { value: 0, wired: false, source: 'demo hosting analytics (not wired)' },
  },
  todayActivity: [
    { type: 'BUSINESS_DISCOVERED', entityType: 'business', entity: 'e609c51a', time: '2026-09-11T13:14:25.923Z' },
  ],
  exceptions: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      priority: 'MEDIUM',
      category: 'discovery_provider_unconfigured',
      message: 'discovery provider requires configuration',
      entityType: 'discovery_job',
      entityId: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-09-11T13:11:00.000Z',
    },
  ],
  health: {
    serverUp: true,
    dbReachable: true,
    tasksByStatus: { COMPLETED: 1, FAILED: 1 },
    taskIssues: ['1 failed task(s)'],
    lastAuditAt: '2026-09-11T13:18:00.000Z',
  },
};

const BUSINESS = {
  id: 'e609c51a-1199-4456-9c71-0401291a5d18',
  businessName: 'TJ Plumber Austin',
  industry: 'plumbing',
  address: '3605 Thompson St',
  city: 'Austin',
  state: 'TX',
  zip: '78702',
  phone: '+15126617896',
  email: null,
  websiteUrl: 'https://tjplumberaustin.com/',
  source: 'google_maps',
  sourceUrl: 'https://maps.google.com/?cid=123',
  rating: 4.7,
  reviewCount: 24,
  businessStatus: 'OPERATIONAL',
  decisionMakerName: null,
  decisionMakerRole: null,
  contactabilityScore: null,
  lifecycleState: 'DISCOVERED',
  legalTransitions: ['ENRICHING', 'REJECTED'],
  latestScore: null,
  websiteAnalyses: [
    { url: 'https://tjplumberaustin.com/', status: 'DISCOVERED', score: null, classification: 'NOT_ANALYZED', analyzedAt: null },
  ],
  demos: [],
  rejections: [],
  history: [],
  recentAudit: [
    { action: 'BUSINESS_DISCOVERED', actorType: 'SYSTEM', createdAt: '2026-09-11T13:14:25.923Z' },
  ],
  createdAt: '2026-09-11T13:14:25.923Z',
  updatedAt: '2026-09-11T13:14:25.923Z',
};

const BUSINESSES_FIXTURE = {
  businesses: [BUSINESS],
  page: 1,
  perPage: 25,
  total: 44,
  totalPages: 2,
};

const DETAIL_FIXTURE = { business: BUSINESS };

const JOBS_FIXTURE = {
  jobs: [
    {
      id: 'deec7da1-73e5-4ffd-b6b2-6ba3756e73fd',
      status: 'COMPLETED',
      provider: 'google_places',
      industry: 'plumbing',
      state: 'TX',
      city: 'Austin',
      attempts: 0,
      progress: { errors: 0, ingested: 44, invalid_skipped: 0, records_fetched: 50, duplicates_skipped: 6 },
      error: null,
      started_at: '2026-09-11T13:14:17.430Z',
      finished_at: '2026-09-11T13:14:25.928Z',
      created_at: '2026-09-11T13:14:17.426Z',
    },
    {
      id: '7d43ed73-a978-48d2-9aed-bd61c34d5bca',
      status: 'FAILED',
      provider: 'none',
      industry: 'plumbing',
      state: 'TX',
      city: 'Austin',
      attempts: 0,
      progress: { errors: 0, ingested: 0, invalid_skipped: 0, records_fetched: 0, duplicates_skipped: 0 },
      error: 'discovery provider requires configuration: DISCOVERY_API_KEY are not set',
      created_at: '2026-09-11T13:11:00.000Z',
    },
  ],
};

const SETTINGS_FIXTURE = {
  settings: [
    {
      key: 'analysis.website_recent_ms',
      value: 86400000,
      type: 'number',
      description: 'Recency window (ms) for website analyses.',
      is_feature_flag: false,
      updated_at: '2026-09-11T13:07:44.157Z',
    },
    {
      key: 'discovery.batch_size',
      value: 25,
      type: 'number',
      description: 'Provider records ingested per batch.',
      is_feature_flag: false,
      updated_at: '2026-09-11T13:07:44.157Z',
    },
  ],
};

const INTEGRATIONS_FIXTURE = {
  modules: [
    { module: 'enrichment', provider: 'none', configured: false, requiresConfiguration: true, missingEnvVars: ['ENRICHMENT_API_KEY'] },
    { module: 'email', provider: 'none', configured: false, requiresConfiguration: true, missingEnvVars: ['EMAIL_API_KEY'] },
    { module: 'demo_hosting', provider: 'none', configured: false, requiresConfiguration: true, missingEnvVars: ['DEMO_HOSTING_API_KEY'] },
    { module: 'deployment', provider: 'none', configured: false, requiresConfiguration: true, missingEnvVars: ['DEPLOYMENT_API_KEY'] },
  ],
  generatedAt: '2026-09-11T13:20:18.602Z',
};

/* ---------------------------------------------------------------------------
 * Minimal DOM shim — supports exactly what console.js touches
 * (createElement/appendChild/textContent/className/id/getElementById/…).
 * ------------------------------------------------------------------------- */

interface Listener {
  (ev?: unknown): void;
}

class FakeElement {
  tagName: string;
  className = '';
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  value = '';
  checked = false;
  selected = false;
  disabled = false;
  hidden = false;
  type = '';
  name = '';
  placeholder = '';
  href = '';
  target = '';
  rel = '';
  title = '';
  style: Record<string, string> = {};
  private text = '';
  private _id = '';
  private listeners: Record<string, Listener[]> = {};

  constructor(tag: string, private registry: Map<string, FakeElement>) {
    this.tagName = tag.toUpperCase();
    Object.defineProperty(this, 'id', {
      get: () => this._id,
      set: (v: string) => {
        this._id = v;
        if (v) registry.set(v, this);
      },
      configurable: true,
    });
  }

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: unknown) {
    this.text = String(v ?? '');
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get lastChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  appendChild<T extends FakeElement>(node: T): T {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node: FakeElement, ref: FakeElement | null): void {
    node.parentNode = this;
    if (!ref) {
      this.children.push(node);
      return;
    }
    const at = this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
  }
  remove(): void {
    if (this.parentNode) {
      const at = this.parentNode.children.indexOf(this);
      if (at >= 0) this.parentNode.children.splice(at, 1);
    }
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(): void {
    /* not needed by console.js */
  }
  focus(): void {
    /* noop */
  }
  setAttribute(k: string, v: string): void {
    (this as unknown as Record<string, unknown>)[k] = v;
  }
  getAttribute(k: string): string | null {
    return ((this as unknown as Record<string, unknown>)[k] as string | undefined) ?? null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  querySelector(sel: string): FakeElement | null {
    // Only used to find a nested <input> (e.g. field().querySelector('input')).
    if (sel === 'input') {
      const found = this.children.find((c) => c.tagName === 'INPUT');
      if (found) return found;
    }
    return null;
  }
  get innerHTML(): string {
    return this.textContent;
  }
  set innerHTML(v: string) {
    this.children = [];
    if (v) this.text = String(v);
    else this.text = '';
  }
  fire(type: string): void {
    (this.listeners[type] ?? []).forEach((fn) => fn({}));
  }
}

interface FakeDocument {
  readyState: string;
  createElement(tag: string): FakeElement;
  createTextNode(text: string): FakeElement;
  getElementById(id: string): FakeElement | null;
  querySelectorAll(): FakeElement[];
  addEventListener(): void;
}

function createDom(): { document: FakeDocument; view: FakeElement } {
  const registry = new Map<string, FakeElement>();
  const view = new FakeElement('main', registry);
  view.id = 'view';
  const document: FakeDocument = {
    readyState: 'complete', // boot() runs synchronously when console.js executes
    createElement: (tag: string) => new FakeElement(tag, registry),
    createTextNode: (text: string) => {
      const n = new FakeElement('#text', registry);
      n.textContent = text;
      return n;
    },
    getElementById: (id: string) => registry.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  return { document, view };
}

interface RunResult {
  viewText: string;
  errorText: string;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Execute the REAL console.js in a fresh DOM shim for the given route and
 * fetch handler, then return the rendered #view text and any error text.
 * fetchImpl receives (url, opts) and returns a {status, ok, json()} response.
 */
async function runView(
  route: string,
  fetchImpl: (url: string, opts?: Record<string, unknown>) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>,
): Promise<RunResult> {
  const { document, view } = createDom();
  const me = new FakeElement('div', new Map());
  me.id = 'me';
  const location = { pathname: route, search: '', href: '' };
  const context = {
    document,
    window: { addEventListener: () => undefined, scrollTo: () => undefined, location },
    location,
    history: { pushState: () => undefined },
    localStorage: {
      getItem: (k: string) => (k === 'lge_owner_access_token' ? 'test-owner-token' : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    fetch: fetchImpl,
    URLSearchParams,
    console,
    setTimeout,
  };
  vm.runInNewContext(CONSOLE_JS, context, { filename: 'console.js' });
  // Let the boot → bootView → api() → .then() chains settle.
  await flushMicrotasks();
  await flushMicrotasks();
  return { viewText: view.textContent, errorText: '' };
}

function okResponse(data: unknown): Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }> {
  return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(data) });
}

function routeFetch(fixtures: Record<string, unknown>) {
  return (url: string): Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }> => {
    // boot() also calls /auth/me to render the sidebar identity — always serve it.
    if (url === '/auth/me') {
      return okResponse({ type: 'user', user: { email: 'owner@localgrowthengine.test' } });
    }
    // Exact-match or prefix-match on the endpoint that console.js calls.
    const hit = Object.keys(fixtures).find((k) => (k.endsWith('*') ? url.startsWith(k.slice(0, -1)) : url === k || url.startsWith(k + '?')));
    if (!hit) throw new Error('unexpected fetch: ' + url);
    return okResponse(fixtures[hit]);
  };
}

/* ---------------------------------------------------------------------------
 * The tests
 * ------------------------------------------------------------------------- */

describe('console view rendering (real console.js executed against API shapes)', () => {
  it('Overview renders real counts, hot leads, activity, exceptions and health', async () => {
    const { viewText } = await runView('/console', routeFetch({ '/api/dashboard/overview': OVERVIEW_FIXTURE }));
    expect(viewText).not.toContain('Could not load this view');
    expect(viewText).toContain('LEADS FOUND');
    expect(viewText).toContain('44');
    expect(viewText).toContain('source not wired');
    expect(viewText).toContain('Hot leads');
    expect(viewText).toContain('Hot Plumber Co');
    expect(viewText).toContain('BUSINESS_DISCOVERED');
    expect(viewText).toContain('discovery_provider_unconfigured');
    expect(viewText).toContain('server up');
    expect(viewText).toContain('db reachable');
  });

  it('Leads renders the real table with pagination metadata', async () => {
    const { viewText } = await runView(
      '/console/leads?per_page=25',
      routeFetch({ '/api/businesses': BUSINESSES_FIXTURE }),
    );
    expect(viewText).not.toContain('Could not load this view');
    expect(viewText).toContain('44 leads · page 1 of 2');
    expect(viewText).toContain('TJ Plumber Austin');
    expect(viewText).toContain('plumbing');
    expect(viewText).toContain('+15126617896');
    expect(viewText).toContain('DISCOVERED');
    expect(viewText).toContain('google_maps');
  });

  it('Lead detail renders NAP, legal lifecycle transitions and history', async () => {
    const { viewText } = await runView(
      '/console/leads/e609c51a-1199-4456-9c71-0401291a5d18',
      routeFetch({ '/api/businesses/e609c51a-1199-4456-9c71-0401291a5d18': DETAIL_FIXTURE }),
    );
    expect(viewText).not.toContain('Could not load this view');
    expect(viewText).toContain('TJ Plumber Austin');
    expect(viewText).toContain('3605 Thompson St');
    expect(viewText).toContain('Legal next states:');
    expect(viewText).toContain('ENRICHING');
    expect(viewText).toContain('REJECTED');
    expect(viewText).toContain('No score recorded yet.');
    expect(viewText).toContain('BUSINESS_DISCOVERED');
  });

  it('Discovery renders the jobs table with honest progress numbers', async () => {
    const { viewText } = await runView(
      '/console/discovery',
      routeFetch({ '/api/discovery/jobs?limit=50': JOBS_FIXTURE }),
    );
    expect(viewText).not.toContain('Could not load this view');
    expect(viewText).toContain('Start job');
    expect(viewText).toContain('COMPLETED');
    expect(viewText).toContain('fetched 50 · ingested 44 · dups 6 · invalid 0 · errors 0');
    expect(viewText).toContain('FAILED');
    expect(viewText).toContain('View leads');
  });

  it('Exceptions renders only CRITICAL/HIGH items with an honest count note', async () => {
    const overviewWithCritical = {
      ...OVERVIEW_FIXTURE,
      exceptions: [
        ...OVERVIEW_FIXTURE.exceptions,
        {
          id: '44444444-4444-4444-8444-444444444444',
          priority: 'CRITICAL',
          category: 'discovery_ingest_failed',
          message: 'ingest batch failed',
          entityType: 'discovery_job',
          entityId: '55555555-5555-4555-8555-555555555555',
          createdAt: '2026-09-11T13:10:00.000Z',
        },
      ],
    };
    const { viewText } = await runView('/console/exceptions', routeFetch({ '/api/dashboard/overview': overviewWithCritical }));
    expect(viewText).not.toContain('Could not load this view');
    expect(viewText).toContain('CRITICAL');
    expect(viewText).toContain('discovery_ingest_failed');
    expect(viewText).toContain('1 lower-priority item');
  });

  it('Settings renders real keys grouped by namespace with Save controls', async () => {
    const { viewText } = await runView('/console/settings', routeFetch({ '/api/settings': SETTINGS_FIXTURE }));
    expect(viewText).not.toContain('Could not load this view');
    // Group names come from the key namespace (display uppercases via CSS).
    expect(viewText).toContain('analysis');
    expect(viewText).toContain('analysis.website_recent_ms');
    expect(viewText).toContain('discovery');
    expect(viewText).toContain('discovery.batch_size');
    expect(viewText).toContain('type number');
  });

  it('Integrations renders honest requires-configuration status per module', async () => {
    const { viewText } = await runView(
      '/console/integrations',
      routeFetch({ '/api/integrations/status': INTEGRATIONS_FIXTURE }),
    );
    expect(viewText).not.toContain('Could not load this view');
    expect(viewText).toContain('enrichment');
    expect(viewText).toContain('email');
    expect(viewText).toContain('demo_hosting');
    expect(viewText).toContain('deployment');
    expect(viewText).toContain('requires configuration');
    expect(viewText).toContain('ENRICHMENT_API_KEY');
  });

  it('regression: every view renderer receives the #view element (bootView must pass it)', async () => {
    // If bootView ever drops the view argument again, EVERY view fails with
    // "…reading 'appendChild'" — spot-check all routes at once.
    const routes: [string, Record<string, unknown>][] = [
      ['/console', { '/api/dashboard/overview': OVERVIEW_FIXTURE }],
      ['/console/leads', { '/api/businesses': BUSINESSES_FIXTURE }],
      ['/console/leads/e609c51a-1199-4456-9c71-0401291a5d18', { '/api/businesses/e609c51a-1199-4456-9c71-0401291a5d18': DETAIL_FIXTURE }],
      ['/console/discovery', { '/api/discovery/jobs?limit=50': JOBS_FIXTURE }],
      ['/console/exceptions', { '/api/dashboard/overview': OVERVIEW_FIXTURE }],
      ['/console/settings', { '/api/settings': SETTINGS_FIXTURE }],
      ['/console/integrations', { '/api/integrations/status': INTEGRATIONS_FIXTURE }],
    ];
    for (const [route, fixtures] of routes) {
      const { viewText } = await runView(route, routeFetch(fixtures));
      expect(viewText, `view ${route} must render without the view-level error`).not.toContain('Could not load this view');
      // Must have rendered real content past the loading placeholder.
      expect(viewText, `view ${route} must render content, not just the placeholder`).toBeTruthy();
      expect(viewText.length, `view ${route} must render content past "Loading…"`).toBeGreaterThan('Loading…'.length);
    }
  });
});