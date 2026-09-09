/**
 * Google Places discovery provider — the REAL lead source for the discovery
 * pipeline (Places API Text Search + Place Details).
 *
 * Honesty rules (same as src/discovery/providers.ts):
 *  - returns ONLY fields actually present in the Google response; absent field
 *    = "not found", never a fabricated value;
 *  - `website_status` is 'present' when a website URL was returned, otherwise
 *    null (we never claim 'verified_absent' — Places never proves absence);
 *  - address parts (city/state/zip) are parsed from `formatted_address` ONLY
 *    when it matches the straightforward US shape "<street>, <City>, <ST>
 *    <ZIP>[, USA]"; otherwise the raw string goes in `address` and city/state
 *    stay unset (a provider must never guess);
 *  - the full raw payload is preserved in `raw` for later re-processing;
 *  - reads DISCOVERY_API_KEY from process.env at CALL time (not import time);
 *    missing/empty → NotConfiguredError naming DISCOVERY_API_KEY;
 *  - real fetch with a timeout, a real User-Agent, and bounded retries on
 *    TRANSIENT errors (HTTP 5xx / network failures / timeouts) only. HTTP 4xx
 *    and Google API-level errors (REQUEST_DENIED, INVALID_REQUEST, ...) fail
 *    fast — retrying those can never help.
 *
 * Requires-configuration: without DISCOVERY_API_KEY in env this provider is
 * unusable; the registry gates on it (see src/discovery/registry.ts).
 */
import { NotConfiguredError } from './providers';
import type { DiscoveryProvider } from './providers';
import type { DiscoveryTarget, RawBusinessRecord } from './types';

/** Stable provider id — select via settings key integrations.discovery.provider. */
export const GOOGLE_PLACES_PROVIDER_ID = 'google_places';

/** Places API endpoints (legacy Text Search + Details — stable public API). */
export const TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
export const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

/** Max Text Search pages per target (each page ≈ 20 results). */
export const GOOGLE_PLACES_MAX_PAGES = 3;
/** Google requires ~2s before a next_page_token becomes valid. */
export const NEXT_PAGE_DELAY_MS = 2000;
/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Bounded retries on transient errors only. */
export const MAX_RETRIES = 2;
/** Minimal injectable HTTP surface (tests stub this; production uses fetch). */
export interface PlacesHttpClient {
  getJson(url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<{
    status: number;
    body: unknown;
  }>;
}

export interface GooglePlacesProviderOptions {
  /** Override the HTTP layer (tests). Defaults to global fetch. */
  http?: PlacesHttpClient;
  /** Max Text Search pages (default GOOGLE_PLACES_MAX_PAGES). */
  maxPages?: number;
  /** Delay before using a next_page_token (default NEXT_PAGE_DELAY_MS). */
  nextPageDelayMs?: number;
  /** Override the sleep (tests skip the ~2s token delay). */
  sleep?: (ms: number) => Promise<void>;
  /** Max retries on transient errors (default MAX_RETRIES). */
  maxRetries?: number;
  /** Whether to call Place Details per result (default true). */
  enrichDetails?: boolean;
}

/** A single Text Search / Details result (only the fields we use). */
export interface PlacesResult {
  place_id?: string;
  name?: string;
  formatted_address?: string;
  formatted_phone_number?: string;
  website?: string;
  rating?: number;
  user_ratings_total?: number;
  business_status?: string;
  url?: string;
  [key: string]: unknown;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultHttp(): PlacesHttpClient {
  return {
    async getJson(url, init) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      // Honor a caller-provided signal on a best-effort basis.
      const onAbort = () => controller.abort();
      init?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'LocalGrowthEngine/1.0 (+discovery)',
            Accept: 'application/json',
            ...(init?.headers ?? {}),
          },
        });
        const body: unknown = await res.json().catch(() => null);
        return { status: res.status, body };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          const e = new Error(`Google Places request timed out after ${REQUEST_TIMEOUT_MS}ms`);
          e.name = 'PlacesTimeoutError';
          throw e;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        init?.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Read the credential at call time — missing/empty → NotConfiguredError. */
export function requireDiscoveryApiKey(): string {
  const key = process.env.DISCOVERY_API_KEY;
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new NotConfiguredError(
      'discovery provider requires configuration: DISCOVERY_API_KEY is not set ' +
        '(add a Google Places API key to env as DISCOVERY_API_KEY)',
    );
  }
  return key.trim();
}

function buildQuery(target: DiscoveryTarget): string {
  const industry = target.industry.trim();
  const state = target.state.trim();
  const city = target.city?.trim();
  return city ? `${industry} in ${city}, ${state}` : `${industry} in ${state}`;
}

/** Transient = worth retrying: HTTP 5xx, 429, timeouts, network failures. */
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'PlacesTimeoutError') return true;
    // Undici/fetch network failures surface as TypeError.
    if (err instanceof TypeError) return true;
  }
  return false;
}

/**
 * Parse "<street>, <City>, <ST> <ZIP>[, USA]" — the standard US
 * formatted_address shape. Returns null unless the shape is exact; callers
 * then keep the raw address and leave city/state unset (never guess).
 */
export function parseFormattedAddress(formatted: string): {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
} | null {
  const parts = formatted.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const last = parts[parts.length - 1]!;
  const rest = parts.slice(0, parts[parts.length - 1]!.toUpperCase() === 'USA' ? -1 : parts.length);
  if (rest.length < 3) return null;
  // Drop a trailing "USA" segment if present.
  const core = last.toUpperCase() === 'USA' ? parts.slice(0, -1) : parts;
  if (core.length < 3) return null;
  const tail = core[core.length - 1]!;
  const m = /^([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(tail);
  if (!m) return null;
  const city = core[core.length - 2]!;
  if (!city || /^\d/.test(city)) return null;
  return {
    address: formatted,
    city,
    state: m[1]!,
    zip: m[2]!,
  };
}

/** Map one Places result → RawBusinessRecord (only fields actually present). */
export function mapPlacesResult(result: PlacesResult): RawBusinessRecord | null {
  const name = typeof result.name === 'string' ? result.name.trim() : '';
  if (!name) return null; // business_name is required — skip nameless results
  const record: RawBusinessRecord = {
    business_name: name,
    source: 'google_maps',
  };
  if (typeof result.place_id === 'string' && result.place_id) {
    record.external_id = result.place_id;
    record.source_url =
      typeof result.url === 'string' && result.url
        ? result.url
        : `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(result.place_id)}`;
  }
  if (typeof result.formatted_address === 'string' && result.formatted_address.trim()) {
    const parsed = parseFormattedAddress(result.formatted_address.trim());
    if (parsed) {
      record.address = parsed.address;
      if (parsed.city) record.city = parsed.city;
      if (parsed.state) record.state = parsed.state;
      if (parsed.zip) record.zip = parsed.zip;
    } else {
      record.address = result.formatted_address.trim();
    }
  }
  if (typeof result.formatted_phone_number === 'string' && result.formatted_phone_number.trim()) {
    record.phone = result.formatted_phone_number.trim();
  }
  if (typeof result.website === 'string' && result.website.trim()) {
    record.website_url = result.website.trim();
    record.website_status = 'present';
  }
  // No website seen → website_status stays unset (null semantics: "didn't
  // verify"; NEVER 'verified_absent' — Places never proves a site is absent).
  if (typeof result.rating === 'number' && Number.isFinite(result.rating)) {
    record.rating = result.rating;
  }
  if (typeof result.user_ratings_total === 'number' && Number.isFinite(result.user_ratings_total)) {
    record.review_count = Math.trunc(result.user_ratings_total);
  }
  if (typeof result.business_status === 'string' && result.business_status) {
    record.business_status = result.business_status;
  }
  record.raw = result as unknown as Record<string, unknown>;
  return record;
}

interface TextSearchResponse {
  status?: string;
  results?: PlacesResult[];
  next_page_token?: string;
  error_message?: string;
}

interface DetailsResponse {
  status?: string;
  result?: PlacesResult;
  error_message?: string;
}

export class GooglePlacesProvider implements DiscoveryProvider {
  readonly id = GOOGLE_PLACES_PROVIDER_ID;

  private readonly http: PlacesHttpClient;
  private readonly maxPages: number;
  private readonly nextPageDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly enrichDetails: boolean;

  constructor(opts: GooglePlacesProviderOptions = {}) {
    this.http = opts.http ?? defaultHttp();
    this.maxPages = opts.maxPages ?? GOOGLE_PLACES_MAX_PAGES;
    this.nextPageDelayMs = opts.nextPageDelayMs ?? NEXT_PAGE_DELAY_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? MAX_RETRIES;
    this.enrichDetails = opts.enrichDetails ?? true;
  }

  /** Stream records for one ICP target (Text Search + per-result Details). */
  async *search(target: DiscoveryTarget): AsyncGenerator<RawBusinessRecord> {
    const apiKey = requireDiscoveryApiKey();
    const query = buildQuery(target);
    let pageToken: string | undefined;
    let page = 0;

    for (;;) {
      if (page > 0) {
        if (!pageToken) break;
        // Google requires ~2s before a next_page_token becomes valid.
        await this.sleep(this.nextPageDelayMs);
      }
      page += 1;

      const params = new URLSearchParams({ query, key: apiKey });
      if (pageToken) params.set('pagetoken', pageToken);
      const res = await this.getWithRetry(`${TEXT_SEARCH_URL}?${params.toString()}`);
      const body = res.body as TextSearchResponse;
      this.throwIfApiError(body.status, body.error_message, 'Text Search');

      const results = Array.isArray(body.results) ? body.results : [];
      for (const result of results) {
        const merged = this.enrichDetails ? await this.enrichOne(result, apiKey) : result;
        const mapped = mapPlacesResult(merged);
        if (mapped) yield mapped;
      }

      const next = typeof body.next_page_token === 'string' ? body.next_page_token : undefined;
      if (!next || page >= this.maxPages) break;
      pageToken = next;
    }
  }

  /** Place Details for one result (website/phone/rating live here). Failures
   *  degrade honestly: keep the Text Search fields, skip enrichment. */
  private async enrichOne(result: PlacesResult, apiKey: string): Promise<PlacesResult> {
    if (typeof result.place_id !== 'string' || !result.place_id) return result;
    try {
      const params = new URLSearchParams({
        place_id: result.place_id,
        fields: 'place_id,name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,business_status,url',
        key: apiKey,
      });
      const res = await this.getWithRetry(`${DETAILS_URL}?${params.toString()}`);
      const body = res.body as DetailsResponse;
      if (body.status && body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
        return result; // honest degradation — Text Search fields still count
      }
      if (!body.result || typeof body.result !== 'object') return result;
      return { ...result, ...body.result };
    } catch {
      return result; // enrichment is best-effort; never fail the whole job
    }
  }

  /** GET with bounded retries on transient (5xx/429/timeout/network) errors. */
  private async getWithRetry(
    url: string,
  ): Promise<{ status: number; body: unknown }> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let res: { status: number; body: unknown };
      try {
        res = await this.http.getJson(url);
      } catch (err) {
        if (attempt <= this.maxRetries && isTransientError(err)) continue;
        throw err;
      }
      if (isTransientStatus(res.status)) {
        if (attempt <= this.maxRetries) continue;
        throw new Error(`Google Places request failed with HTTP ${res.status} after ${attempt} attempts`);
      }
      if (res.status >= 400) {
        throw new Error(`Google Places request failed with HTTP ${res.status}`);
      }
      return res;
    }
  }

  /** Google API-level errors (REQUEST_DENIED, INVALID_REQUEST, ...) fail fast. */
  private throwIfApiError(status: string | undefined, errorMessage: string | undefined, call: string): void {
    if (!status || status === 'OK' || status === 'ZERO_RESULTS') return;
    const detail = errorMessage ? `: ${errorMessage}` : '';
    throw new Error(`Google Places ${call} error: ${status}${detail}`);
  }
}
