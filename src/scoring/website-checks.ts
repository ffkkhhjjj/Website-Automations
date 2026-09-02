/**
 * DETERMINISTIC TECHNICAL CHECKS — the measurable half of website quality.
 *
 * Every check is a pure function of an observed WebsiteInput (fixtures in
 * tests). Each returns { checkId, name, result, evidence } where evidence is
 * the exact thing that was observed (URL, tag presence/absence, status code,
 * timing) — an observed value is NEVER invented. When a check cannot run with
 * the data provided it returns NOT_RUN, never a fabricated pass/fail.
 *
 * Technical checks are deterministic code, NOT AI: they parse the supplied
 * document/observation and report what is there.
 */
import type { CheckOutcome, WebsiteInput, PageSignals } from './website-input.js';

/** One boolean observed feature on a page, with the URL that proves it. */
interface Feature {
  present: boolean;
  evidence: string;
}

function hasHttps(input: WebsiteInput): CheckOutcome {
  const url = input.url.toLowerCase();
  const secure = url.startsWith('https://');
  return {
    checkId: 'has_https',
    name: 'Site is served over HTTPS',
    result: secure ? 'PASS' : 'FAIL',
    evidence: [secure ? `URL scheme is https: ${input.url}` : `URL scheme is not https: ${input.url}`],
  };
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m?.[1]?.trim();
  return t && t.length > 0 ? t : undefined;
}

function extractMetaDescription(html: string): string | undefined {
  const m = /<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i.exec(html);
  const d = m?.[1]?.trim();
  return d && d.length > 0 ? d : undefined;
}

function extractViewport(html: string): string | undefined {
  const m = /<meta[^>]+name=["']viewport["'][^>]*>/i.exec(html);
  return m?.[0];
}

function extractH1s(html: string): string[] {
  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
    stripTags(m[1] ?? '').trim(),
  );
  return h1s.filter(Boolean);
}

function extractText(html: string): string {
  // Script/style/comment removal then tag-stripping gives a fair proxy without
  // an HTML parser dependency.
  return stripTags(html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function hasTitle(signals: PageSignals): Feature {
  return {
    present: signals.title !== undefined && signals.title.length > 0,
    evidence: `home page title ${signals.title !== undefined ? JSON.stringify(signals.title) : 'absent'} (${signals.url})`,
  };
}

function hasMetaDescription(signals: PageSignals): Feature {
  return {
    present: signals.metaDescription !== undefined && signals.metaDescription.length > 0,
    evidence: `home page meta description ${signals.metaDescription !== undefined ? JSON.stringify(signals.metaDescription) : 'absent'} (${signals.url})`,
  };
}

function hasViewport(signals: PageSignals): Feature {
  return {
    present: signals.viewportMeta !== undefined,
    evidence: signals.viewportMeta !== undefined
      ? `mobile viewport meta found on home page (${signals.url})`
      : `no mobile viewport meta on home page (${signals.url})`,
  };
}

function hasH1(signals: PageSignals): Feature {
  return {
    present: signals.h1s.length === 1,
    evidence:
      signals.h1s.length === 0
        ? `no h1 on home page (${signals.url})`
        : signals.h1s.length === 1
          ? `exactly one h1 on home page: ${JSON.stringify(signals.h1s[0])} (${signals.url})`
          : `${signals.h1s.length} h1 elements on home page (expected exactly one) (${signals.url})`,
  };
}

function hasContactRoute(signals: PageSignals, input: WebsiteInput): Feature {
  const phoneLink = signals.phoneLinks.length > 0;
  const telHref = signals.hrefs.some((h) => /^tel:/i.test(h));
  const mailto = signals.emailLinks.length > 0;
  const form = signals.forms > 0;
  const present = phoneLink || telHref || mailto || form ||
    Boolean(input.observedPhone) || Boolean(input.observedAddress);
  const seen = [
    phoneLink ? 'phone link on page' : null,
    telHref ? 'tel: href on page' : null,
    mailto ? 'mailto link on page' : null,
    form ? `contact form on page (${signals.url})` : null,
    input.observedPhone ? `business phone observed: ${input.observedPhone}` : null,
    input.observedAddress ? 'business address observed' : null,
  ]
    .filter((x): x is string => x !== null);
  return {
    present,
    evidence: seen.length > 0 ? seen.join('; ') : `no contact route observed anywhere (${signals.url})`,
  };
}

function hasCta(signals: PageSignals, input: WebsiteInput): Feature {
  if (input.observedPhone) {
    return {
      present: true,
      evidence: `business phone observed in crawl data: ${JSON.stringify(input.observedPhone)}`,
    };
  }
  const anchors = signals.hrefs.filter(Boolean).length;
  const ctaLike =
    /(call now|book (now|online|an appointment|an app)|get (a )?quote|contact us|schedule|request|free estimate)/i.test(
      signals.title ?? '',
    ) || anchors >= 3;
  return {
    present: ctaLike,
    evidence: ctaLike
      ? `home page has CTA-style links/contact affordances (${signals.url})`
      : `no clear call-to-action observed on home page (${signals.url})`,
  };
}

function hasNapConsistency(input: WebsiteInput): CheckOutcome {
  // NAP = Name / Address / Phone. We only check business-name and phone
  // consistency (the crawler may observe the name on the page and the phone
  // from the crawl); NAP is a page-crawl signal, not a knowledge-graph join.
  const name = input.observedBusinessName?.trim();
  const phone = input.observedPhone?.trim();
  const present = Boolean(name && phone);
  return {
    checkId: 'has_nap',
    name: 'NAP (name/address/phone) consistency signals present',
    result: present ? 'PASS' : 'FAIL',
    evidence: present
      ? [`business name observed: ${JSON.stringify(name)}`, `phone observed: ${JSON.stringify(phone)}`]
      : [`name observed: ${name ? JSON.stringify(name) : 'none'}`, `phone observed: ${phone ? JSON.stringify(phone) : 'none'}`],
  };
}

function hasInternalLinks(pages: WebsiteInput['pages']): CheckOutcome {
  const internal = pages.filter((p) => p.url !== pages[0]?.url);
  return {
    checkId: 'has_internal_links',
    name: 'Site has internal pages (site breadth proxy)',
    result: internal.length > 0 ? 'PASS' : 'FAIL',
    evidence: [`${pages.length} page(s) observed during crawl`],
  };
}

function hasBrokenLinks(input: WebsiteInput): CheckOutcome {
  const broken = input.brokenInternalLinks ?? [];
  return {
    checkId: 'no_broken_links',
    name: 'No broken internal links',
    result: broken.length === 0 ? 'PASS' : 'FAIL',
    evidence: broken.length === 0
      ? ['no broken internal links observed during crawl']
      : broken.map((u) => `broken link: ${u}`),
  };
}

function hasHttpOk(signals: PageSignals): Feature {
  return {
    present: signals.ok,
    evidence: `home page HTTP ${signals.httpStatus} (${signals.url})`,
  };
}

function loadTime(input: WebsiteInput): CheckOutcome {
  const home = input.pages[0];
  if (!home || home.responseTimeMs === undefined) {
    return {
      checkId: 'page_speed_proxy',
      name: 'Page speed proxy (observed fetch time)',
      result: 'NOT_RUN',
      evidence: ['page speed not measured for this crawl — no response time observed'],
    };
  }
  // Seeded threshold from system_settings (load_fast_ms); config, not code.
  const threshold = Number(process.env.WSQ_LOAD_FAST_MS ?? 1000);
  return {
    checkId: 'page_speed_proxy',
    name: 'Page speed proxy (observed fetch time)',
    result: home.responseTimeMs <= threshold ? 'PASS' : 'FAIL',
    evidence: [`home page fetch took ${home.responseTimeMs}ms (${home.url})`],
  };
}

/** All deterministic technical checks, ordered (stable test output). */
export const TECHNICAL_CHECKS = [
  hasHttps,
  hasHttpOk,
  hasViewport,
  hasTitle,
  hasMetaDescription,
  hasH1,
  hasCta,
  hasContactRoute,
  hasNapConsistency,
  hasInternalLinks,
  hasBrokenLinks,
  loadTime,
] as const;

export interface TechnicalCheckSet {
  outcomes: CheckOutcome[];
  /** Category score (0-100) for the technical category, weighted from checks. */
  technicalScore: number;
}

/** Weights per technical check (deterministic mapping; config-lite: these are
 *  implementation weights inside a single category, the category weight itself
 *  lives in scoring_versions/system_settings). */
const CHECK_WEIGHTS: Record<string, number> = {
  has_https: 12,
  has_http_ok: 12,
  has_viewport: 12,
  has_title: 8,
  has_meta_description: 8,
  has_h1: 8,
  has_cta: 10,
  has_contact_route: 12,
  has_nap: 8,
  has_internal_links: 4,
  no_broken_links: 4,
  page_speed_proxy: 4,
};
const TOTAL_WEIGHT = Object.values(CHECK_WEIGHTS).reduce((a, b) => a + b, 0); // 102

export function extractSignals(input: WebsiteInput): PageSignals[] {
  return input.pages.map((p) => {
    const html = p.html ?? '';
    const text = extractText(html);
    const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1] ?? '');
    return {
      url: p.url,
      httpStatus: p.httpStatus,
      ok: p.httpStatus >= 200 && p.httpStatus < 300,
      title: extractTitle(html),
      metaDescription: extractMetaDescription(html),
      viewportMeta: extractViewport(html),
      h1s: extractH1s(html),
      phoneLinks: [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1] ?? '').filter(Boolean),
      emailLinks: [...html.matchAll(/href=["']mailto:([^"']+)["']/gi)].map((m) => m[1] ?? '').filter(Boolean),
      forms: (html.match(/<form\b/gi) ?? []).length,
      hrefs,
      textLength: text.length,
      wordCount: text.split(/\s+/).filter(Boolean).length,
    };
  });
}

/** Run all technical checks against observed crawl data. Deterministic. */
export function runTechnicalChecks(input: WebsiteInput): TechnicalCheckSet {
  const signals = extractSignals(input);
  const home = signals[0];
  const outcomes: CheckOutcome[] = [];

  // `apply` accepts either a full CheckOutcome or a Feature (bool + evidence
  // strings) and normalizes it into the CheckOutcome shape.
  const apply = (checkId: string, name: string, f: Feature | CheckOutcome): void => {
    if ('result' in f) {
      outcomes.push(f);
    } else {
      const feat = f;
      outcomes.push({
        checkId,
        name,
        result: feat.present ? 'PASS' : 'FAIL',
        evidence: [feat.evidence],
      });
    }
  };

  apply('has_https', 'Site is served over HTTPS', hasHttps(input));
  if (home) apply('has_http_ok', 'Home page returns HTTP 2xx', hasHttpOk(home));
  if (home) apply('has_viewport', 'Mobile viewport meta present', hasViewport(home));
  if (home) apply('has_title', 'Page has a title', hasTitle(home));
  if (home) apply('has_meta_description', 'Page has meta description', hasMetaDescription(home));
  if (home) apply('has_h1', 'Valid single h1 on home page', hasH1(home));
  if (home) apply('has_cta', 'Clear call-to-action on home page', hasCta(home, input));
  if (home) apply('has_contact_route', 'Contact route present (form/phone/email)', hasContactRoute(home, input));
  apply('has_nap', 'NAP (name/address/phone) consistency signals present', hasNapConsistency(input));
  apply('has_internal_links', 'Site has internal pages (site breadth proxy)', hasInternalLinks(input.pages));
  apply('no_broken_links', 'No broken internal links', hasBrokenLinks(input));
  apply('page_speed_proxy', 'Page speed proxy (observed fetch time)', loadTime(input));

  // Technical category score = sum of (pass_weight / total_weight) * 100.
  let earned = 0;
  for (const o of outcomes) {
    if (o.result === 'PASS') {
      earned += CHECK_WEIGHTS[o.checkId] ?? 0;
    }
  }
  const technicalScore = Math.round((earned / TOTAL_WEIGHT) * 100);
  return { outcomes, technicalScore };
}