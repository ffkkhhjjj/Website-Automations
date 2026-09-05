/**
 * WEBSITE FETCHER — safely fetch a business website and produce a WebsiteInput.
 *
 * This is the missing "crawl layer" of the website quality pipeline. Everything
 * here is deterministic TypeScript with no external vendor and no AI — it only
 * observes what the server actually returns. In that it follows the same rule
 * as the in-repo QA pipeline: it is NOT a swappable integration registry module
 * (those exist for external services with credentials; fetching a public web
 * page from a known URL takes none).
 *
 * Honesty rules:
 *  - evidence is only ever what was observed (status codes, timing, HTML);
 *  - a page that could not be fetched is skipped or reported as a broken
 *    internal link — never fabricated;
 *  - every request has a deadline (AbortSignal.timeout) and bounded retries
 *    ONLY for transient failures (network errors / timeouts / 5xx). A 404/403
 *    is a stable outcome and is never retried.
 *
 * Crawl scope: home page + a small budget of same-domain internal pages
 * (about/services/contact preferred, max 3) so NAP/contact analysis has real
 * material. Non-text links (mailto:, tel:, .pdf, #fragments, images) are
 * skipped. The home page fetch ALWAYS counts even when it returns non-2xx
 * (a 404 home page is still evidence).
 */
import type { PageObservation, WebsiteInput } from './website-input.js';

export const DEFAULT_FETCH_OPTIONS = {
  /** Per-request timeout (AbortSignal.timeout). */
  requestTimeoutMs: 10_000,
  /** Max redirects followed per request (http/https only). */
  maxRedirects: 5,
  /** Max response body bytes kept for parsing (2 MB HTML is plenty). */
  maxHtmlBytes: 2 * 1024 * 1024,
  /** Max internal pages crawled AFTER the home page. */
  pageBudget: 3,
  /** Transient-error retries (network/timeout/5xx), with backoff. */
  maxRetries: 2,
  /** Base backoff before each retry (ms); doubles per attempt. */
  retryBaseDelayMs: 250,
  /** Overall crawl deadline — every request inside shares this bound. */
  overallTimeoutMs: 30_000,
} as const;

export interface FetchOptions {
  requestTimeoutMs?: number;
  maxRedirects?: number;
  maxHtmlBytes?: number;
  pageBudget?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  overallTimeoutMs?: number;
}

export interface FetchResult {
  ok: boolean;
  websiteInput?: WebsiteInput;
  failure?: FetchFailure;
}

export interface FetchFailure {
  reason:
    | 'INVALID_URL'
    | 'DNS_FAILURE'
    | 'TIMEOUT'
    | 'CONNECTION_FAILED'
    | 'TLS_FAILURE'
    | 'HTTP_ERROR'
    | 'TOO_MANY_REDIRECTS'
    | 'CRAWL_TIMEOUT'
    | 'INTERNAL_ERROR';
  message: string;
  /** Home-page HTTP status when the failure was an HTTP status. */
  httpStatus?: number;
}

interface FetchedPage {
  page: PageObservation;
  /** True when a 2xx HTML response was actually received. */
  ok: boolean;
  /** Where this page ended up after redirects (observed URL for evidence). */
  finalUrl: string;
}

/** Observed NAP-ish strings collected from page text (evidence only). */
interface NapHits {
  businessName?: string;
  phone?: string;
  address?: string;
}

/**
 * Normalize a user-supplied website URL into an absolute http(s) URL.
 * Returns undefined for clearly invalid/empty input. Scheme is added when
 * missing (https preferred; the caller may fall back to http).
 */
export function normalizeWebsiteUrl(raw: string | null | undefined): string | undefined {
  const input = (raw ?? '').trim();
  if (input === '') return undefined;
  if (input.length > 2048) return undefined;
  // A lone trailing slash is noise; a path like /services is legitimate.
  const candidate = input.replace(/\/+$/, '');
  // Reject characters that can never appear in a sane web URL.
  if (!/^[a-zA-Z0-9-._~:/?#[\]@!$&'()*+,;=%]+$/.test(candidate)) return undefined;
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.hostname === '') return undefined;
  return url.toString();
}

/** True when the URL is on the same registered domain as `base`. */
export function isInternalUrl(candidate: string, base: string): boolean {
  try {
    const a = new URL(candidate, base);
    const b = new URL(base);
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
    return registeredDomainOf(a.hostname) === registeredDomainOf(b.hostname);
  } catch {
    return false;
  }
}

/** Registrable domain = last two labels (public-suffix awareness is out of
 *  scope; two-label matching keeps the crawl same-site for ordinary hosts). */
function registeredDomainOf(hostname: string): string {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

/** Links worth crawling: http(s), same registered domain, textual pages. */
export function isCrawlableLink(href: string, base: string): boolean {
  if (/^(mailto:|tel:|javascript:|data:|#|blob:)/i.test(href.trim())) return false;
  if (/\.(pdf|png|jpe?g|gif|svg|webp|ico|css|js|zip|docx?|xlsx?|mp4|mp3)(\?.*)?$/i.test(href)) return false;
  return isInternalUrl(href, base);
}

function isHtmlResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') ?? '';
  return /text\/html|application\/xhtml\+xml/i.test(ct);
}

/** Dig through Node fetch's `TypeError: fetch failed` wrapper to the real
 *  error (undici stores the underlying error in err.cause). */
function unwrapError(err: unknown): Error {
  let current = err;
  const seen = new Set<unknown>();
  while (current instanceof Error && current.cause instanceof Error && !seen.has(current.cause)) {
    seen.add(current.cause);
    current = current.cause;
  }
  return current instanceof Error ? current : new Error(String(current));
}

function isTransientError(err: unknown): boolean {
  const e = unwrapError(err);
  const name = e.name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EACCES|EPIPE|EADDRNOTAVAIL|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i.test(e.message)) {
    return true;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBody(buf: Buffer): string {
  if (buf.length === 0) return '';
  // A leading UTF-8 BOM would otherwise appear in the parsed text.
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

const USER_AGENT =
  'LocalGrowthEngine/0.1 (+website-quality analysis; contact: owner@localgrowthengine.local)';

/**
 * Crawl one URL: bounded redirects, per-request timeout, bounded retries for
 * transient failures only (network/timeout/5xx). 4xx/stable outcomes are
 * returned as observed, never retried. Resolves undefined when the overall
 * crawl deadline aborted the request.
 */
async function fetchWithRetry(
  url: string,
  opts: Required<FetchOptions>,
  signal: AbortSignal,
): Promise<FetchedPage | undefined> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (signal.aborted) return undefined;
    if (attempt > 0) {
      await delay(Math.min(opts.retryBaseDelayMs * 2 ** (attempt - 1), 3000));
      if (signal.aborted) return undefined;
    }

    let currentUrl = url;
    let redirects = 0;
    const started = Date.now();
    try {
      for (;;) {
        if (redirects > opts.maxRedirects) {
          return {
            page: { url: currentUrl, httpStatus: 0, responseTimeMs: Date.now() - started },
            ok: false,
            finalUrl: currentUrl,
          };
        }
        const res = await fetch(currentUrl, {
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(opts.requestTimeoutMs)]),
          headers: {
            accept: 'text/html,application/xhtml+xml',
            'accept-encoding': 'gzip, deflate',
            'user-agent': USER_AGENT,
          },
        });
        const elapsed = Date.now() - started;

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          await res.arrayBuffer().catch(() => undefined);
          if (!loc) {
            // Redirect with no Location — observed 3xx, not a page.
            return { page: { url: currentUrl, httpStatus: res.status, responseTimeMs: elapsed }, ok: false, finalUrl: currentUrl };
          }
          const next = new URL(loc, currentUrl);
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return { page: { url: currentUrl, httpStatus: res.status, responseTimeMs: elapsed }, ok: false, finalUrl: currentUrl };
          }
          redirects += 1;
          currentUrl = next.toString();
          continue;
        }

        if (res.status >= 500 && res.status <= 599) {
          // 5xx is transient by nature — retry the whole chain with backoff.
          lastErr = new Error(`HTTP ${res.status} from ${currentUrl}`);
          await res.arrayBuffer().catch(() => undefined);
          break; // → outer retry loop
        }
        if (res.status === 200 && isHtmlResponse(res)) {
          const buf = Buffer.from(await res.arrayBuffer());
          const body = buf.length > opts.maxHtmlBytes ? buf.subarray(0, opts.maxHtmlBytes) : buf;
          return {
            page: {
              url: currentUrl,
              httpStatus: res.status,
              html: decodeBody(body),
              responseTimeMs: elapsed,
            },
            ok: true,
            finalUrl: res.url ?? currentUrl,
          };
        }
        // 2xx non-HTML or any 4xx — observed outcome, never retried.
        await res.arrayBuffer().catch(() => undefined);
        return {
          page: { url: currentUrl, httpStatus: res.status, responseTimeMs: elapsed },
          ok: false,
          finalUrl: currentUrl,
        };
      }
    } catch (err) {
      lastErr = err;
      if (signal.aborted) return undefined;
      if (!isTransientError(err)) return undefined;
    }
  }
  // All retries exhausted on transient errors — the caller classifies.
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

/** Try the http:// variant when a scheme-less input's https attempt failed at
 *  the transport level (or 5xx) — the brief's "try https then http" rule.
 *  Explicit schemes are respected as-is. */
function httpVariantOf(raw: string | null | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (/^https?:\/\//i.test(trimmed)) return undefined;
  const normalized = normalizeWebsiteUrl(trimmed);
  if (!normalized) return undefined;
  return normalized.replace(/^https:\/\//, 'http://');
}

/** Transport-ish failures that justify trying the http variant. */
function retriableViaHttpVariant(f: FetchFailure): boolean {
  return (
    f.reason === 'DNS_FAILURE' ||
    f.reason === 'CONNECTION_FAILED' ||
    f.reason === 'TLS_FAILURE' ||
    f.reason === 'TIMEOUT' ||
    (f.reason === 'HTTP_ERROR' && (f.httpStatus ?? 0) >= 500)
  );
}

/**
 * Fetch the home page and a budget of internal pages, returning a WebsiteInput
 * or a structured failure. Never throws.
 */
export async function fetchWebsite(
  rawUrl: string | null | undefined,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const normalized = normalizeWebsiteUrl(rawUrl);
  if (!normalized) {
    return { ok: false, failure: { reason: 'INVALID_URL', message: 'website URL is empty or invalid' } };
  }
  const options: Required<FetchOptions> = {
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_FETCH_OPTIONS.requestTimeoutMs,
    maxRedirects: opts.maxRedirects ?? DEFAULT_FETCH_OPTIONS.maxRedirects,
    maxHtmlBytes: opts.maxHtmlBytes ?? DEFAULT_FETCH_OPTIONS.maxHtmlBytes,
    pageBudget: opts.pageBudget ?? DEFAULT_FETCH_OPTIONS.pageBudget,
    maxRetries: opts.maxRetries ?? DEFAULT_FETCH_OPTIONS.maxRetries,
    retryBaseDelayMs: opts.retryBaseDelayMs ?? DEFAULT_FETCH_OPTIONS.retryBaseDelayMs,
    overallTimeoutMs: opts.overallTimeoutMs ?? DEFAULT_FETCH_OPTIONS.overallTimeoutMs,
  };

  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), options.overallTimeoutMs);
  try {
    // The URL that actually produced the home page. Normally `normalized`;
    // when the https attempt fails at the transport level for scheme-less
    // input, the http fallback's URL is reported instead — never a scheme
    // that was never successfully fetched (downstream checks and storage
    // must see the observed URL, not a fiction).
    let startUrl = normalized;
    let home = await fetchWithRetry(startUrl, options, controller.signal);
    if (!home && controller.signal.aborted) {
      return {
        ok: false,
        failure: { reason: 'CRAWL_TIMEOUT', message: `website crawl exceeded ${options.overallTimeoutMs}ms deadline` },
      };
    }
    if (!home) {
      // https attempt failed at the transport level — try http for scheme-less input.
      const httpUrl = httpVariantOf(rawUrl);
      if (httpUrl && httpUrl !== normalized) {
        home = await fetchWithRetry(httpUrl, options, controller.signal);
        if (home) startUrl = httpUrl;
      }
    }
    if (!home) {
      return { ok: false, failure: { reason: 'CONNECTION_FAILED', message: `could not fetch home page at ${normalized}` } };
    }

    // Home page 4xx/5xx → the site does not serve HTML: a stable failure.
    if (!home.ok && home.page.httpStatus >= 400) {
      return {
        ok: false,
        failure: {
          reason: 'HTTP_ERROR',
          message: `home page returned HTTP ${home.page.httpStatus} (${home.finalUrl})`,
          httpStatus: home.page.httpStatus,
        },
      };
    }
    // Redirect loop / no response at all → nothing meaningful was fetched.
    if (!home.ok && home.page.httpStatus === 0) {
      return {
        ok: false,
        failure: {
          reason: 'TOO_MANY_REDIRECTS',
          message: `home page exceeded ${options.maxRedirects} redirects or returned no response (${home.finalUrl})`,
        },
      };
    }

    const pages: PageObservation[] = [home.page];
    const baseUrl = home.finalUrl;
    const visited = new Set<string>([home.page.url]);
    const seenHrefs = new Set<string>();
    const brokenInternalLinks: string[] = [];
    const nap: NapHits = {};

    // Discover internal links from the home page; prefer about/services/contact.
    const homeHtml = home.page.html ?? '';
    // Home-page signals first: the home title is the authoritative business
    // name, so it must claim the slot before sub-page titles are seen.
    collectNapSignals(homeHtml, nap);
    const hrefs = [...homeHtml.matchAll(/href=["']([^"']+)["']/gi)]
      .map((m) => m[1] ?? '')
      .filter((h) => isCrawlableLink(h, baseUrl))
      .map((h) => new URL(h, baseUrl).toString())
      .filter((u) => !visited.has(u) && !seenHrefs.has(u) && (seenHrefs.add(u), true))
      .sort((a, b) => rankHref(a) - rankHref(b));

    for (const target of hrefs.slice(0, options.pageBudget)) {
      if (controller.signal.aborted) break;
      const p = await fetchWithRetry(target, options, controller.signal);
      if (!p) continue;
      if (!visited.has(p.page.url)) {
        visited.add(p.page.url);
        if (p.page.httpStatus > 0) {
          pages.push(p.page);
        }
      }
      if (p.page.httpStatus === 0 || p.page.httpStatus >= 400) {
        brokenInternalLinks.push(p.page.url);
      }
      collectNapSignals(p.page.html ?? '', nap);
    }

    const websiteInput: WebsiteInput = {
      // Observed start URL (not the https guess when the http fallback won).
      url: startUrl,
      pages,
      observedBusinessName: nap.businessName,
      observedPhone: nap.phone,
      observedAddress: nap.address,
      brokenInternalLinks: brokenInternalLinks.length > 0 ? brokenInternalLinks : undefined,
    };
    return { ok: true, websiteInput };
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        failure: { reason: 'CRAWL_TIMEOUT', message: `website crawl exceeded ${options.overallTimeoutMs}ms deadline` },
      };
    }
    return { ok: false, failure: classifyError(err, normalized) };
  } finally {
    clearTimeout(overallTimer);
  }
}

/** Rank internal links: about/services/contact first (deterministic crawl). */
function rankHref(url: string): number {
  const path = url.toLowerCase();
  if (/(about|services?|contact)/.test(path)) return 0;
  if (/\/$/.test(path)) return 1;
  return 2;
}

function classifyError(err: unknown, url: string): FetchFailure {
  const e = unwrapError(err);
  if (/ENOTFOUND|EAI_AGAIN/.test(e.message)) {
    return { reason: 'DNS_FAILURE', message: `DNS lookup failed for ${url}: ${e.message}` };
  }
  if (e.name === 'TimeoutError') {
    return { reason: 'TIMEOUT', message: `request to ${url} timed out` };
  }
  if (/ECONNREFUSED/.test(e.message)) {
    return { reason: 'CONNECTION_FAILED', message: `connection refused for ${url}: ${e.message}` };
  }
  if (/CERT_|SSL|TLS/.test(e.message)) {
    return { reason: 'TLS_FAILURE', message: `TLS error for ${url}: ${e.message}` };
  }
  if (/ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT/.test(e.message)) {
    return { reason: 'CONNECTION_FAILED', message: `connection error for ${url}: ${e.message}` };
  }
  return {
    reason: 'INTERNAL_ERROR',
    message: e instanceof Error ? e.message : 'unknown fetch error',
  };
}

/** Extract NAP-ish strings from page text (evidence only, never invented). */
const PHONE_RE =
  /(\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/;
const ADDRESS_RE =
  /(\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9.,' -]{2,}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Pkwy|Parkway|Hwy|Highway|Way|Place|Pl)\b\.?)/i;

function collectNapSignals(html: string, nap: NapHits): void {
  const text = html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (!nap.phone) {
    const m = PHONE_RE.exec(text);
    if (m) nap.phone = m[0];
  }
  if (!nap.address) {
    const m = ADDRESS_RE.exec(text);
    if (m) nap.address = m[1];
  }
  if (!nap.businessName) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
    const og = /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([\s\S]*?)["']/i.exec(html)?.[1]?.trim();
    const candidate = (og ?? title ?? '').split(/[|–—-]/)[0]?.trim();
    if (candidate && candidate.length >= 2 && candidate.length <= 60) {
      nap.businessName = candidate;
    }
  }
}

/** Rank internal links: about/services/contact first (deterministic crawl). */