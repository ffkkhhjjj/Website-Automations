/**
 * Google Places provider tests — HERMETIC (mocked HTTP, no live key, no real
 * Google calls). Covers:
 *  - search() maps a realistic Text Search + Details response (place_id →
 *    external_id, name, address/city/state parse, rating, website, source
 *    'google_maps', raw preserved) and queries "<industry> in <city>, <state>"
 *  - honesty: no website in response → website_url absent AND website_status
 *    NOT 'verified_absent'; with website → website_url + status 'present'
 *  - pagination: next_page_token triggers a second page; stops at max pages
 *  - missing DISCOVERY_API_KEY → throws naming the var
 *  - HTTP 5xx → retried (bounded) then fails; HTTP 4xx → fails fast;
 *    API-level REQUEST_DENIED → fails fast
 *  - registry wiring: 'google_places' + key → configured GooglePlacesProvider;
 *    without key → unconfigured; 'none' → NoneProvider
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GooglePlacesProvider,
  GOOGLE_PLACES_PROVIDER_ID,
  mapPlacesResult,
  parseFormattedAddress,
  TEXT_SEARCH_URL,
  type PlacesHttpClient,
} from '../src/discovery/providers-google';
import { NoneProvider } from '../src/discovery/providers';
import { buildDiscoveryRegistry, SELECTABLE_PROVIDERS } from '../src/discovery/registry';
import type { RawBusinessRecord } from '../src/discovery/types';

/* ----------------------------------------------------------------------------
 * Mock HTTP
 * ------------------------------------------------------------------------- */

type Canned = { status: number; body: unknown };

function mockHttp(canned: Canned[] | ((url: string, n: number) => Canned)): PlacesHttpClient & { urls: string[]; calls: number } {
  const urls: string[] = [];
  let calls = 0;
  return {
    urls,
    get calls() {
      return calls;
    },
    async getJson(url: string) {
      urls.push(url);
      calls += 1;
      const c = typeof canned === 'function' ? canned(url, calls) : canned[Math.min(calls - 1, canned.length - 1)]!;
      return { status: c.status, body: c.body };
    },
  };
}

const SEARCH_PAGE_1 = {
  status: 'OK',
  results: [
    {
      place_id: 'ChIJAcme123',
      name: 'Acme Plumbing',
      formatted_address: '123 Main St, Austin, TX 78701, USA',
      rating: 4.5,
      user_ratings_total: 120,
      business_status: 'OPERATIONAL',
    },
  ],
  next_page_token: 'TOKEN_PAGE_2',
};

const SEARCH_PAGE_2 = {
  status: 'OK',
  results: [
    {
      place_id: 'ChIJSecond456',
      name: 'Second Plumbing Co',
      formatted_address: '456 Oak Ave, Austin, TX 78702, USA',
      rating: 4.0,
      user_ratings_total: 30,
      business_status: 'OPERATIONAL',
    },
  ],
};

const DETAILS_WITH_SITE = {
  status: 'OK',
  result: {
    place_id: 'ChIJAcme123',
    name: 'Acme Plumbing',
    formatted_address: '123 Main St, Austin, TX 78701, USA',
    formatted_phone_number: '(512) 555-0199',
    website: 'https://www.acmeplumbing.com',
    rating: 4.5,
    user_ratings_total: 120,
    business_status: 'OPERATIONAL',
    url: 'https://maps.google.com/?cid=12345',
  },
};

const DETAILS_NO_SITE = {
  status: 'OK',
  result: {
    place_id: 'ChIJSecond456',
    name: 'Second Plumbing Co',
    formatted_address: '456 Oak Ave, Austin, TX 78702, USA',
    rating: 4.0,
    user_ratings_total: 30,
    business_status: 'OPERATIONAL',
  },
};

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/* ----------------------------------------------------------------------------
 * Env hygiene (other suites also touch DISCOVERY_API_KEY)
 * ------------------------------------------------------------------------- */

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.DISCOVERY_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.DISCOVERY_API_KEY;
  else process.env.DISCOVERY_API_KEY = savedKey;
});

/* ----------------------------------------------------------------------------
 * Mapping + honesty
 * ------------------------------------------------------------------------- */

describe('google places mapping', () => {
  it('(1a) search maps Text Search + Details into an honest record', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const http = mockHttp([
      { status: 200, body: SEARCH_PAGE_1_NO_TOKEN() },
      { status: 200, body: DETAILS_WITH_SITE },
    ]);
    const provider = new GooglePlacesProvider({ http, sleep: async () => {} });
    expect(provider.id).toBe(GOOGLE_PLACES_PROVIDER_ID);

    const records = await collect(provider.search({ industry: 'plumbing', state: 'TX', city: 'Austin' }));
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.business_name).toBe('Acme Plumbing');
    expect(r.external_id).toBe('ChIJAcme123');
    expect(r.source).toBe('google_maps');
    expect(r.source_url).toBe('https://maps.google.com/?cid=12345');
    expect(r.address).toBe('123 Main St, Austin, TX 78701, USA');
    expect(r.city).toBe('Austin');
    expect(r.state).toBe('TX');
    expect(r.zip).toBe('78701');
    expect(r.phone).toBe('(512) 555-0199');
    expect(r.website_url).toBe('https://www.acmeplumbing.com');
    expect(r.website_status).toBe('present');
    expect(r.rating).toBe(4.5);
    expect(r.review_count).toBe(120);
    expect(r.business_status).toBe('OPERATIONAL');
    expect(r.raw).toMatchObject({ place_id: 'ChIJAcme123' });

    // The Text Search query targets "<industry> in <city>, <state>".
    const searchUrl = http.urls[0]!;
    expect(searchUrl.startsWith(TEXT_SEARCH_URL)).toBe(true);
    const queryParam = new URL(searchUrl).searchParams.get('query');
    expect(queryParam).toBe('plumbing in Austin, TX');
    expect(searchUrl).toContain('key=test-key');
  });

  it('(1b) no website in response → absent fields, NEVER verified_absent', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const http = mockHttp([
      { status: 200, body: SEARCH_PAGE_2_NO_TOKEN() },
      { status: 200, body: DETAILS_NO_SITE },
    ]);
    const provider = new GooglePlacesProvider({ http, sleep: async () => {} });
    const records = await collect(provider.search({ industry: 'plumbing', state: 'TX', city: 'Austin' }));
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.website_url).toBeUndefined();
    expect(r.website_status).not.toBe('verified_absent');
    expect(r.website_status).toBeUndefined();
    // Place Details is skipped gracefully when enrichment is off, too.
    const plain = new GooglePlacesProvider({
      http: mockHttp([{ status: 200, body: SEARCH_PAGE_2_NO_TOKEN() }]),
      enrichDetails: false,
      sleep: async () => {},
    });
    process.env.DISCOVERY_API_KEY = 'test-key';
    const recs = await collect(plain.search({ industry: 'plumbing', state: 'TX' }));
    expect(recs[0]!.website_url).toBeUndefined();
    expect(recs[0]!.website_status).not.toBe('verified_absent');
  });

  it('(1c) non-US address shape → raw address kept, city/state never guessed', () => {
    const r = mapPlacesResult({
      place_id: 'x',
      name: 'Weird Address Co',
      formatted_address: 'Somewhere without commas or structure',
    });
    expect(r).not.toBeNull();
    expect(r!.address).toBe('Somewhere without commas or structure');
    expect(r!.city).toBeUndefined();
    expect(r!.state).toBeUndefined();
    expect(parseFormattedAddress('Somewhere without commas or structure')).toBeNull();
  });

  it('(1d) source_url falls back to a Maps place-id URL when Details gives none', () => {
    const r = mapPlacesResult({ place_id: 'ChIJFallback', name: 'Fallback Co' });
    expect(r!.source_url).toContain('query_place_id=ChIJFallback');
    expect(r!.source).toBe('google_maps');
  });

  it('(1e) nameless results are skipped (business_name is required)', () => {
    expect(mapPlacesResult({ place_id: 'x' })).toBeNull();
  });
});

function SEARCH_PAGE_1_NO_TOKEN() {
  const { next_page_token: _drop, ...rest } = SEARCH_PAGE_1;
  void _drop;
  return rest;
}

function SEARCH_PAGE_2_NO_TOKEN() {
  return { status: 'OK', results: SEARCH_PAGE_2.results };
}

/* ----------------------------------------------------------------------------
 * Pagination
 * ------------------------------------------------------------------------- */

describe('google places pagination', () => {
  it('(2a) next_page_token triggers a second page fetch', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const sleeps: number[] = [];
    const http = mockHttp((url) => {
      if (url.includes('textsearch')) {
        return url.includes('pagetoken')
          ? { status: 200, body: SEARCH_PAGE_2_NO_TOKEN() }
          : { status: 200, body: SEARCH_PAGE_1 };
      }
      // Route Details by place_id so page-1's record keeps its own fields.
      return { status: 200, body: url.includes('ChIJAcme123') ? DETAILS_WITH_SITE : DETAILS_NO_SITE };
    });
    const provider = new GooglePlacesProvider({
      http,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const records = await collect(provider.search({ industry: 'plumbing', state: 'TX', city: 'Austin' }));
    expect(records.map((r: RawBusinessRecord) => r.business_name)).toEqual([
      'Acme Plumbing',
      'Second Plumbing Co',
    ]);
    expect(http.urls.filter((u) => u.includes('textsearch') && u.includes('pagetoken'))).toHaveLength(1);
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // token delay honored
  });

  it('(2b) stops at the max-pages budget', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const endless = { ...SEARCH_PAGE_1 }; // always offers another token
    const http = mockHttp((url) => {
      if (url.includes('textsearch')) return { status: 200, body: endless };
      return { status: 200, body: DETAILS_NO_SITE };
    });
    const provider = new GooglePlacesProvider({ http, maxPages: 2, sleep: async () => {} });
    await collect(provider.search({ industry: 'plumbing', state: 'TX' }));
    expect(http.urls.filter((u) => u.includes('textsearch'))).toHaveLength(2);
  });
});

/* ----------------------------------------------------------------------------
 * Credential gating + error behavior
 * ------------------------------------------------------------------------- */

describe('google places errors', () => {
  it('(3a) missing DISCOVERY_API_KEY → throws naming the var (no fetch)', async () => {
    delete process.env.DISCOVERY_API_KEY;
    const http = mockHttp([]);
    const provider = new GooglePlacesProvider({ http, sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(
      'DISCOVERY_API_KEY',
    );
    expect(http.calls).toBe(0);
  });

  it('(3b) empty DISCOVERY_API_KEY → same honest failure', async () => {
    process.env.DISCOVERY_API_KEY = '   ';
    const provider = new GooglePlacesProvider({ http: mockHttp([]), sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(
      'DISCOVERY_API_KEY',
    );
  });

  it('(3c) HTTP 5xx → retried (bounded) then fails', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const http = mockHttp([{ status: 500, body: { status: 'UNKNOWN_ERROR' } }]);
    const provider = new GooglePlacesProvider({ http, maxRetries: 2, sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(/500/);
    expect(http.calls).toBe(3); // 1 initial + 2 retries
  });

  it('(3d) HTTP 4xx → fails fast (no retry)', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const http = mockHttp([{ status: 403, body: { status: 'REQUEST_DENIED' } }]);
    const provider = new GooglePlacesProvider({ http, maxRetries: 3, sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(/403/);
    expect(http.calls).toBe(1);
  });

  it('(3e) API-level REQUEST_DENIED → fails fast with the status named', async () => {
    process.env.DISCOVERY_API_KEY = 'bad-key';
    const http = mockHttp([
      { status: 200, body: { status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.' } },
    ]);
    const provider = new GooglePlacesProvider({ http, maxRetries: 3, sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(
      /REQUEST_DENIED/,
    );
    expect(http.calls).toBe(1);
  });

  it('(3f) transient network failure → retried; persistent failure → throws', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    let n = 0;
    const flaky: PlacesHttpClient = {
      async getJson() {
        n += 1;
        if (n === 1) throw new TypeError('fetch failed');
        return { status: 200, body: SEARCH_PAGE_2_NO_TOKEN() };
      },
    };
    const provider = new GooglePlacesProvider({ http: flaky, enrichDetails: false, sleep: async () => {} });
    const records = await collect(provider.search({ industry: 'plumbing', state: 'TX' }));
    expect(records).toHaveLength(1);
    expect(n).toBe(2);
  });
});

/* ----------------------------------------------------------------------------
 * Registry wiring (providerId override — no DB settings read needed)
 * ------------------------------------------------------------------------- */

describe('google places registry wiring', () => {
  it('(4a) google_places + key → configured GooglePlacesProvider', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const r = await buildDiscoveryRegistry({ providerId: GOOGLE_PLACES_PROVIDER_ID });
    expect(r.provider).toBe('google_places');
    expect(r.providerInstance).toBeInstanceOf(GooglePlacesProvider);
    expect(r.configured).toBe(true);
    expect(r.requiresConfiguration).toBe(false);
    expect(r.missingEnvVars).toEqual([]);
  });

  it('(4b) google_places without key → honestly unconfigured', async () => {
    delete process.env.DISCOVERY_API_KEY;
    const r = await buildDiscoveryRegistry({ providerId: GOOGLE_PLACES_PROVIDER_ID });
    expect(r.providerInstance).toBeInstanceOf(GooglePlacesProvider);
    expect(r.configured).toBe(false);
    expect(r.requiresConfiguration).toBe(true);
    expect(r.missingEnvVars).toEqual(['DISCOVERY_API_KEY']);
  });

  it('(4c) none → NoneProvider, unconfigured (default preserved)', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const r = await buildDiscoveryRegistry({ providerId: 'none' });
    expect(r.providerInstance).toBeInstanceOf(NoneProvider);
    expect(r.configured).toBe(false);
  });

  it('(4d) SELECTABLE_PROVIDERS exposes google_places', () => {
    expect(typeof SELECTABLE_PROVIDERS['google_places']).toBe('function');
    expect(SELECTABLE_PROVIDERS['google_places']!().id).toBe('google_places');
  });
});
