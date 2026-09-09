/**
 * Google Places provider tests — HERMETIC (mocked HTTP, no live key, no real
 * Google calls). Covers the Places API (New):
 *  - search() POSTs places:searchText with X-Goog-Api-Key + field mask and a
 *    textQuery "<industry> in <city>, <state>", then maps Text Search +
 *    Details into honest records (id → external_id, name, address/city/state
 *    parse, rating, website, source 'google_maps', raw preserved)
 *  - honesty: no website in response → website_url absent AND website_status
 *    NOT 'verified_absent'; with website → website_url + status 'present'
 *  - phone/rating/businessStatus mapping (new field names); unknown
 *    businessStatus passes through honestly, never fabricated
 *  - pagination: nextPageToken → second page body pageToken; stops at max pages
 *  - Details failure degrades to Text Search fields, never fails the job
 *  - missing DISCOVERY_API_KEY → throws naming the var
 *  - HTTP 5xx/429 → retried (bounded) then fails; HTTP 4xx (403/404/400) →
 *    fails fast with the Google message text; error envelope (error.status /
 *    error.message) mapping
 *  - registry wiring: 'google_places' + key → configured GooglePlacesProvider;
 *    without key → unconfigured; 'none' → NoneProvider
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GooglePlacesProvider,
  GOOGLE_PLACES_PROVIDER_ID,
  DETAILS_FIELD_MASK,
  SEARCH_FIELD_MASK,
  TEXT_SEARCH_URL,
  PLACE_DETAILS_URL_BASE,
  mapPlacesResult,
  parseFormattedAddress,
  type PlacesHttpClient,
} from '../src/discovery/providers-google';
import { NoneProvider } from '../src/discovery/providers';
import { buildDiscoveryRegistry, SELECTABLE_PROVIDERS } from '../src/discovery/registry';
import type { RawBusinessRecord } from '../src/discovery/types';

/* ----------------------------------------------------------------------------
 * Mock HTTP (New API request surface)
 * ------------------------------------------------------------------------- */

type Canned = { status: number; body: unknown };

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockHttp(
  canned: Canned[] | ((req: SeenRequest, n: number) => Canned),
): PlacesHttpClient & { requests: SeenRequest[]; calls: number } {
  const requests: SeenRequest[] = [];
  let calls = 0;
  return {
    requests,
    get calls() {
      return calls;
    },
    async requestJson(input) {
      calls += 1;
      requests.push({ url: input.url, method: input.method, headers: { ...input.headers }, body: input.body });
      const c =
        typeof canned === 'function'
          ? canned({ url: input.url, method: input.method, headers: { ...input.headers }, body: input.body }, calls)
          : canned[Math.min(calls - 1, canned.length - 1)]!;
      return { status: c.status, body: c.body };
    },
  };
}

function searchRequests(http: { requests: SeenRequest[] }): SeenRequest[] {
  return http.requests.filter((r) => r.url === TEXT_SEARCH_URL);
}

function detailsRequests(http: { requests: SeenRequest[] }): SeenRequest[] {
  return http.requests.filter((r) => r.url.startsWith(`${PLACE_DETAILS_URL_BASE}/`));
}

const SEARCH_PAGE_1 = {
  places: [
    {
      id: 'places/ChIJAcme123',
      displayName: { text: 'Acme Plumbing', languageCode: 'en' },
      formattedAddress: '123 Main St, Austin, TX 78701, USA',
      rating: 4.5,
      userRatingCount: 120,
      businessStatus: 'OPERATIONAL',
    },
  ],
  nextPageToken: 'TOKEN_PAGE_2',
};

const SEARCH_PAGE_2 = {
  places: [
    {
      id: 'places/ChIJSecond456',
      displayName: { text: 'Second Plumbing Co', languageCode: 'en' },
      formattedAddress: '456 Oak Ave, Austin, TX 78702, USA',
      rating: 4.0,
      userRatingCount: 30,
      businessStatus: 'OPERATIONAL',
    },
  ],
};

const DETAILS_WITH_SITE = {
  id: 'places/ChIJAcme123',
  displayName: { text: 'Acme Plumbing', languageCode: 'en' },
  formattedAddress: '123 Main St, Austin, TX 78701, USA',
  nationalPhoneNumber: '(512) 555-0199',
  websiteUri: 'https://www.acmeplumbing.com',
  rating: 4.5,
  userRatingCount: 120,
  businessStatus: 'OPERATIONAL',
  googleMapsUri: 'https://maps.google.com/?cid=12345',
};

const DETAILS_NO_SITE = {
  id: 'places/ChIJSecond456',
  displayName: { text: 'Second Plumbing Co', languageCode: 'en' },
  formattedAddress: '456 Oak Ave, Austin, TX 78702, USA',
  rating: 4.0,
  userRatingCount: 30,
  businessStatus: 'OPERATIONAL',
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
    expect(r.external_id).toBe('places/ChIJAcme123');
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
    expect(r.raw).toMatchObject({ id: 'places/ChIJAcme123' });

    // Text Search uses POST places:searchText with the API-key header, a field
    // mask, and a textQuery "<industry> in <city>, <state>".
    const searches = searchRequests(http);
    expect(searches).toHaveLength(1);
    const first = searches[0]!;
    expect(first.method).toBe('POST');
    expect(first.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(first.headers['X-Goog-FieldMask']).toBe(SEARCH_FIELD_MASK);
    expect(first.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(first.body!)).toEqual({ textQuery: 'plumbing in Austin, TX' });

    // Details uses GET places/{placeId} with the same key header + mask.
    const details = detailsRequests(http);
    expect(details).toHaveLength(1);
    expect(details[0]!.method).toBe('GET');
    expect(details[0]!.url).toBe(`${PLACE_DETAILS_URL_BASE}/${encodeURIComponent('places/ChIJAcme123')}`);
    expect(details[0]!.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(details[0]!.headers['X-Goog-FieldMask']).toBe(DETAILS_FIELD_MASK);
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
      id: 'x',
      displayName: { text: 'Weird Address Co' },
      formattedAddress: 'Somewhere without commas or structure',
    });
    expect(r).not.toBeNull();
    expect(r!.address).toBe('Somewhere without commas or structure');
    expect(r!.city).toBeUndefined();
    expect(r!.state).toBeUndefined();
    expect(parseFormattedAddress('Somewhere without commas or structure')).toBeNull();
  });

  it('(1d) source_url falls back to a Maps place-id URL when Details gives none', () => {
    const r = mapPlacesResult({ id: 'places/ChIJFallback', displayName: { text: 'Fallback Co' } });
    expect(r!.source_url).toContain('query=place_id:places%2FChIJFallback');
    expect(r!.source).toBe('google_maps');
  });

  it('(1e) nameless results are skipped (business_name is required)', () => {
    expect(mapPlacesResult({ id: 'x' })).toBeNull();
  });

  it('(1f) phone prefers national, falls back to international; rating + closed status map honestly', () => {
    const r = mapPlacesResult({
      id: 'places/x',
      displayName: { text: 'Phone Co' },
      nationalPhoneNumber: '(512) 555-0100',
      internationalPhoneNumber: '+1 512-555-0100',
      rating: 3.5,
      userRatingCount: 7,
      businessStatus: 'CLOSED_PERMANENTLY',
    });
    expect(r!.phone).toBe('(512) 555-0100');
    expect(r!.rating).toBe(3.5);
    expect(r!.review_count).toBe(7);
    expect(r!.business_status).toBe('CLOSED_PERMANENTLY');

    const intl = mapPlacesResult({
      id: 'places/y',
      displayName: { text: 'Intl Co' },
      internationalPhoneNumber: '+1 512-555-0199',
      businessStatus: 'SOME_FUTURE_STATUS',
    });
    expect(intl!.phone).toBe('+1 512-555-0199');
    // Unknown statuses pass through honestly, never fabricated into a known one.
    expect(intl!.business_status).toBe('SOME_FUTURE_STATUS');
  });
});

function SEARCH_PAGE_1_NO_TOKEN() {
  const { nextPageToken: _drop, ...rest } = SEARCH_PAGE_1;
  void _drop;
  return rest;
}

function SEARCH_PAGE_2_NO_TOKEN() {
  return { places: SEARCH_PAGE_2.places };
}

/* ----------------------------------------------------------------------------
 * Pagination
 * ------------------------------------------------------------------------- */

describe('google places pagination', () => {
  it('(2a) nextPageToken triggers a second page fetch with pageToken in the body', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const sleeps: number[] = [];
    const http = mockHttp((req) => {
      if (req.url === TEXT_SEARCH_URL) {
        const body = JSON.parse(req.body ?? '{}') as { pageToken?: string };
        return { status: 200, body: body.pageToken ? SEARCH_PAGE_2_NO_TOKEN() : SEARCH_PAGE_1 };
      }
      // Route Details by place id so page-1's record keeps its own fields.
      return {
        status: 200,
        body: req.url.includes(encodeURIComponent('places/ChIJAcme123')) ? DETAILS_WITH_SITE : DETAILS_NO_SITE,
      };
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
    const searches = searchRequests(http);
    expect(searches).toHaveLength(2);
    expect(JSON.parse(searches[1]!.body!)).toEqual({
      textQuery: 'plumbing in Austin, TX',
      pageToken: 'TOKEN_PAGE_2',
    });
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // page delay honored
  });

  it('(2b) stops at the max-pages budget', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const endless = { ...SEARCH_PAGE_1 }; // always offers another token
    const http = mockHttp((req) => {
      if (req.url === TEXT_SEARCH_URL) return { status: 200, body: endless };
      return { status: 200, body: DETAILS_NO_SITE };
    });
    const provider = new GooglePlacesProvider({ http, maxPages: 2, sleep: async () => {} });
    await collect(provider.search({ industry: 'plumbing', state: 'TX' }));
    expect(searchRequests(http)).toHaveLength(2);
  });

  it('(2c) Details failure degrades to Text Search fields, never fails the job', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const http = mockHttp((req) => {
      if (req.url === TEXT_SEARCH_URL) return { status: 200, body: SEARCH_PAGE_2_NO_TOKEN() };
      return { status: 200, body: { error: { code: 404, message: 'Not found.', status: 'NOT_FOUND' } } };
    });
    const provider = new GooglePlacesProvider({ http, sleep: async () => {} });
    const records = await collect(provider.search({ industry: 'plumbing', state: 'TX' }));
    expect(records).toHaveLength(1);
    expect(records[0]!.business_name).toBe('Second Plumbing Co');
    expect(records[0]!.external_id).toBe('places/ChIJSecond456');
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
    const http = mockHttp([{ status: 500, body: { error: { code: 500, message: 'Backend error.', status: 'UNKNOWN' } } }]);
    const provider = new GooglePlacesProvider({ http, maxRetries: 2, sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(/500/);
    expect(http.calls).toBe(3); // 1 initial + 2 retries
  });

  it('(3c2) HTTP 429 → retried (bounded) then fails', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const http = mockHttp([
      { status: 429, body: { error: { code: 429, message: 'Quota exceeded.', status: 'RESOURCE_EXHAUSTED' } } },
    ]);
    const provider = new GooglePlacesProvider({ http, maxRetries: 2, sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(/429/);
    expect(http.calls).toBe(3);
  });

  it('(3d) HTTP 403 → fails fast with the Google message (no retry)', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    const http = mockHttp([
      {
        status: 403,
        body: { error: { code: 403, message: 'Places API (New) is not enabled.', status: 'PERMISSION_DENIED' } },
      },
    ]);
    const provider = new GooglePlacesProvider({ http, maxRetries: 3, sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(
      /Places API \(New\) is not enabled/,
    );
    expect(http.calls).toBe(1);
  });

  it('(3e) error envelope (PERMISSION_DENIED) → fails fast with the status named', async () => {
    process.env.DISCOVERY_API_KEY = 'bad-key';
    const http = mockHttp([
      {
        status: 200,
        body: { error: { code: 403, message: 'API key not valid.', status: 'PERMISSION_DENIED' } },
      },
    ]);
    const provider = new GooglePlacesProvider({ http, maxRetries: 3, sleep: async () => {} });
    await expect(collect(provider.search({ industry: 'plumbing', state: 'TX' }))).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    expect(http.calls).toBe(1);
  });

  it('(3f) transient network failure → retried; persistent failure → throws', async () => {
    process.env.DISCOVERY_API_KEY = 'test-key';
    let n = 0;
    const flaky: PlacesHttpClient = {
      async requestJson() {
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
