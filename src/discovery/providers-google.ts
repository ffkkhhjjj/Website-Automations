/**
 * Google Places discovery provider — the REAL lead source for the discovery
 * pipeline (Places API (New): Text Search + Place Details).
 *
 * Legacy Maps-API place endpoints are refused for this
 * project (REQUEST_DENIED: "You're calling a legacy API..."), so this provider
 * uses the Places API (New):
 *  - Text Search: POST https://places.googleapis.com/v1/places:searchText
 *    with `X-Goog-Api-Key` + `X-Goog-FieldMask` headers;
 *  - Place Details: GET https://places.googleapis.com/v1/places/{placeId}
 *    with the same auth header and a details field mask.
 *
 * Honesty rules (same as src/discovery/providers.ts):
 *  - returns ONLY fields actually present in the Google response; absent field
 *    = "not found", never a fabricated value;
 *  - `website_status` is 'present' when a website URL was returned, otherwise
 *    null (we never claim 'verified_absent' — Places never proves absence);
 *  - address parts (city/state/zip) are parsed from `formattedAddress` ONLY
 *    when it matches the straightforward US shape "<street>, <City>, <ST>
 *    <ZIP>[, USA]"; otherwise the raw string goes in `address` and city/state
 *    stay unset (a provider must never guess);
 *  - the full raw payload is preserved in `raw` for later re-processing;
 *  - reads DISCOVERY_API_KEY from process.env at CALL time (not import time);
 *    missing/empty → NotConfiguredError naming DISCOVERY_API_KEY;
 *  - real fetch with a timeout, a real User-Agent, and bounded retries on
 *    TRANSIENT errors (HTTP 429 / 5xx / network failures / timeouts) only.
 *    HTTP 400/403/404 (e.g. PERMISSION_DENIED, NOT_FOUND) and Google
 *    API-level error envelopes fail fast — retrying those can never help.
 *
 * Requires-configuration: without DISCOVERY_API_KEY in env this provider is
 * unusable; the registry gates on it (see src/discovery/registry.ts). Also
 * requires "Places API (New)" enabled in the Google Cloud Console — the legacy
 * Places API endpoints are refused.
 */
import { NotConfiguredError } from './providers.js';
import type { DiscoveryProvider } from './providers.js';
import type { DiscoveryTarget, RawBusinessRecord } from './types.js';

/** Stable provider id — select via settings key integrations.discovery.provider. */
export const GOOGLE_PLACES_PROVIDER_ID = 'google_places';

/** Places API (New) endpoints. */
export const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
export const PLACE_DETAILS_URL_BASE = 'https://places.googleapis.com/v1/places';

/** Field mask for Text Search responses (New API field names). */
export const SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.websiteUri,' +
  'places.nationalPhoneNumber,places.internationalPhoneNumber,places.rating,' +
  'places.userRatingCount,places.businessStatus,places.googleMapsUri,nextPageToken';

/** Field mask for Place Details responses (New API field names). */
export const DETAILS_FIELD_MASK =
  'id,websiteUri,nationalPhoneNumber,internationalPhoneNumber,rating,' +
  'userRatingCount,businessStatus,googleMapsUri,formattedAddress';

/** Max Text Search pages per target (each page ≈ 20 results). */
export const GOOGLE_PLACES_MAX_PAGES = 3;
/** Delay between paged Text Search requests (keeps parity with legacy pacing). */
export const NEXT_PAGE_DELAY_MS = 2000;
/** Per-request timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Bounded retries on transient errors only. */
export const MAX_RETRIES = 2;

/** Minimal injectable HTTP surface (tests stub this; production uses fetch). */
export interface PlacesHttpClient {
  requestJson(input: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{
    status: number;
    body: unknown;
  }>;
}

/** Back-compat alias for the HTTP surface. */
export type PlacesHttp = PlacesHttpClient;

export interface GooglePlacesProviderOptions {
  /** Override the HTTP layer (tests). Defaults to global fetch. */
  http?: PlacesHttpClient;
  /** Max Text Search pages (default GOOGLE_PLACES_MAX_PAGES). */
  maxPages?: number;
  /** Delay between paged requests (default NEXT_PAGE_DELAY_MS). */
  nextPageDelayMs?: number;
  /** Override the sleep (tests skip the ~2s page delay). */
  sleep?: (ms: number) => Promise<void>;
  /** Max retries on transient errors (default MAX_RETRIES). */
  maxRetries?: number;
  /** Whether to call Place Details per result (default true). */
  enrichDetails?: boolean;
}

/**
 * A single Places API (New) place (only the fields we use). Text Search embeds
 * these under `places[]`; Details returns one at the top level.
 */
export interface PlacesResult {
  id?: string;
  displayName?: string | { text?: string; languageCode?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  googleMapsUri?: string;
  [key: string]: unknown;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(): Error {
  const e = new Error(`Google Places request timed out after ${REQUEST_TIMEOUT_MS}ms`);
  e.name = 'PlacesTimeoutError';
  return e;
}

function defaultHttp(): PlacesHttpClient {
  return {
    async requestJson(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      // Honor a caller-provided signal on a best-effort basis.
      const onAbort = () => controller.abort();
      input.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(input.url, {
          method: input.method,
          signal: controller.signal,
          headers: {
            'User-Agent': 'LocalGrowthEngine/1.0 (+discovery)',
            Accept: 'application/json',
            ...input.headers,
          },
          body: input.body,
        });
        const body: unknown = await res.json().catch(() => null);
        return { status: res.status, body };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw timeoutError();
        }
        throw err;
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
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

/** Transient = worth retrying: HTTP 429 / 5xx, timeouts, network failures. */
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
 * formattedAddress shape. Returns null unless the shape is exact; callers
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

function displayNameText(displayName: PlacesResult['displayName']): string {
  if (typeof displayName === 'string') return displayName.trim();
  if (displayName && typeof displayName === 'object') {
    const text = (displayName as { text?: unknown }).text;
    if (typeof text === 'string') return text.trim();
  }
  return '';
}

/** Map one Places API (New) place → RawBusinessRecord (only fields actually present). */
export function mapPlacesResult(result: PlacesResult): RawBusinessRecord | null {
  const name = displayNameText(result.displayName);
  if (!name) return null; // business_name is required — skip nameless results
  const record: RawBusinessRecord = {
    business_name: name,
    source: 'google_maps',
  };
  if (typeof result.id === 'string' && result.id) {
    record.external_id = result.id;
    record.source_url =
      typeof result.googleMapsUri === 'string' && result.googleMapsUri
        ? result.googleMapsUri
        : `https://www.google.com/maps/search/?api=1&query=place_id:${encodeURIComponent(result.id)}`;
  }
  if (typeof result.formattedAddress === 'string' && result.formattedAddress.trim()) {
    const parsed = parseFormattedAddress(result.formattedAddress.trim());
    if (parsed) {
      record.address = parsed.address;
      if (parsed.city) record.city = parsed.city;
      if (parsed.state) record.state = parsed.state;
      if (parsed.zip) record.zip = parsed.zip;
    } else {
      record.address = result.formattedAddress.trim();
    }
  }
  const phone =
    typeof result.nationalPhoneNumber === 'string' && result.nationalPhoneNumber.trim()
      ? result.nationalPhoneNumber.trim()
      : typeof result.internationalPhoneNumber === 'string' && result.internationalPhoneNumber.trim()
        ? result.internationalPhoneNumber.trim()
        : undefined;
  if (phone) {
    record.phone = phone;
  }
  if (typeof result.websiteUri === 'string' && result.websiteUri.trim()) {
    record.website_url = result.websiteUri.trim();
    record.website_status = 'present';
  }
  // No website seen → website_status stays unset (null semantics: "didn't
  // verify"; NEVER 'verified_absent' — Places never proves a site is absent).
  if (typeof result.rating === 'number' && Number.isFinite(result.rating)) {
    record.rating = result.rating;
  }
  if (typeof result.userRatingCount === 'number' && Number.isFinite(result.userRatingCount)) {
    record.review_count = Math.trunc(result.userRatingCount);
  }
  if (typeof result.businessStatus === 'string' && result.businessStatus) {
    record.business_status = result.businessStatus;
  }
  record.raw = result as unknown as Record<string, unknown>;
  return record;
}

interface TextSearchResponse {
  places?: PlacesResult[];
  nextPageToken?: string;
  error?: PlacesApiError;
}

interface PlacesApiError {
  code?: number;
  message?: string;
  status?: string;
}

type PlaceDetailsResponse = PlacesResult & { error?: PlacesApiError };

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
        await this.sleep(this.nextPageDelayMs);
      }
      page += 1;

      const res = await this.requestWithRetry({
        url: TEXT_SEARCH_URL,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': SEARCH_FIELD_MASK,
        },
        body: JSON.stringify(
          pageToken ? { textQuery: query, pageToken } : { textQuery: query },
        ),
      });
      const body = (res.body ?? {}) as TextSearchResponse;
      this.throwIfApiError(body.error, 'Text Search');

      const results = Array.isArray(body.places) ? body.places : [];
      for (const result of results) {
        const merged = this.enrichDetails ? await this.enrichOne(result, apiKey) : result;
        const mapped = mapPlacesResult(merged);
        if (mapped) yield mapped;
      }

      const next = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
      if (!next || page >= this.maxPages) break;
      pageToken = next;
    }
  }

  /** Place Details for one result (website/phone/rating live here). Failures
   *  degrade honestly: keep the Text Search fields, skip enrichment. */
  private async enrichOne(result: PlacesResult, apiKey: string): Promise<PlacesResult> {
    if (typeof result.id !== 'string' || !result.id) return result;
    try {
      const res = await this.requestWithRetry({
        url: `${PLACE_DETAILS_URL_BASE}/${encodeURIComponent(result.id)}`,
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': DETAILS_FIELD_MASK,
        },
      });
      const body = (res.body ?? {}) as PlaceDetailsResponse;
      if (body.error) return result; // honest degradation — Text Search fields still count
      const { error: _drop, ...details } = body;
      void _drop;
      if (!details || typeof details !== 'object' || typeof details.id !== 'string') return result;
      return { ...result, ...details };
    } catch {
      return result; // enrichment is best-effort; never fail the whole job
    }
  }

  /** Request with bounded retries on transient (429/5xx/timeout/network) errors. */
  private async requestWithRetry(input: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown }> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let res: { status: number; body: unknown };
      try {
        res = await this.http.requestJson(input);
      } catch (err) {
        if (attempt <= this.maxRetries && isTransientError(err)) continue;
        throw err;
      }
      if (isTransientStatus(res.status)) {
        if (attempt <= this.maxRetries) continue;
        throw new Error(`Google Places request failed with HTTP ${res.status} after ${attempt} attempts`);
      }
      if (res.status >= 400) {
        throw new Error(`Google Places request failed with HTTP ${res.status}${this.errorDetail(res.body)}`);
      }
      return res;
    }
  }

  private errorDetail(body: unknown): string {
    if (body && typeof body === 'object') {
      const err = (body as { error?: PlacesApiError }).error;
      if (err && typeof err.message === 'string' && err.message.trim()) {
        return `: ${err.message.trim()}`;
      }
    }
    return '';
  }

  /** Google API-level error envelopes fail fast (retrying can never help). */
  private throwIfApiError(error: PlacesApiError | undefined, call: string): void {
    if (!error) return;
    const status = typeof error.status === 'string' && error.status ? error.status : 'API_ERROR';
    const detail = typeof error.message === 'string' && error.message.trim() ? `: ${error.message.trim()}` : '';
    throw new Error(`Google Places ${call} error: ${status}${detail}`);
  }
}
