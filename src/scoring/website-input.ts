/**
 * Input shapes for the website quality analysis pipeline.
 *
 * These are the "observed evidence" payloads the crawler/discovery pipeline
 * (later brief) will produce. Every field is something a scraper can genuinely
 * observe; nothing here is invented. Tests build fixtures from these shapes.
 */

/** A single page observed by the crawler. `html` may be omitted for pages
 *  that were HEAD-fetched or blocked — checks that need it then report
 *  not-run, never a fabricated value. */
export interface PageObservation {
  url: string;
  /** HTTP status observed for this page. */
  httpStatus: number;
  /** Raw HTML when a full fetch succeeded. */
  html?: string;
  /** Observed fetch timing (ms), when measured. */
  responseTimeMs?: number;
}

/** Overall crawl observation for a website. */
export interface WebsiteInput {
  url: string;
  /** Pages observed (home + any internal pages). */
  pages: PageObservation[];
  /** Business name observed anywhere on the site (for NAP checks). */
  observedBusinessName?: string;
  /** Phone observed on the site (for NAP/contact checks). */
  observedPhone?: string;
  /** Address observed on the site (for NAP/address/CTA checks). */
  observedAddress?: string;
  /** A URL that returned 4xx/5xx during the crawl (evidence of broken links). */
  brokenInternalLinks?: string[];
}

/** Signals a technical check can report. NOT_RUN = could not be measured with
 *  the data provided (never a fabricated value). */
export type CheckResult = 'PASS' | 'FAIL' | 'NOT_RUN';

/** One deterministic technical check outcome, with the observed evidence. */
export interface CheckOutcome {
  checkId: string;
  /** Human-readable check name. */
  name: string;
  result: CheckResult;
  /** What was actually observed (URL, snippet, status code, timing...). */
  evidence: string[];
}

/** Normalized one-page signals extracted by the checks (shared so each check
 *  parses once). */
export interface PageSignals {
  url: string;
  httpStatus: number;
  /** 2xx observed. */
  ok: boolean;
  title?: string;
  metaDescription?: string;
  viewportMeta?: string;
  h1s: string[];
  phoneLinks: string[];
  emailLinks: string[];
  forms: number;
  hrefs: string[];
  /** Text content length of the page, when html was present. */
  textLength: number;
  wordCount: number;
}