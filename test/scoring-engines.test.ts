/**
 * Scoring engine tests — pure (no DB) for the deterministic engines.
 *
 * Covers the WSQ engine (fixture websites, NO_WEBSITE, classification bands,
 * evidence-bearing checks, not-run honesty), the fallback subjective evaluator
 * (determinism + evidence), the BOS engine (signal sensitivity, conservative
 * absent signals, icp_fit vs target config), and the lead priority formula
 * (hand-computed example + classification thresholds).
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeWebsite,
  scoreNoWebsite,
  classifyWebsiteScore,
} from '../src/scoring/website-quality';
import { runTechnicalChecks } from '../src/scoring/website-checks';
import {
  DeterministicFallbackEvaluator,
} from '../src/scoring/subjective';
import { scoreOpportunity } from '../src/scoring/business-opportunity';
import { scoreLeadPriority, classifyLeadPriority } from '../src/scoring/lead-priority';
import {
  DEFAULT_WEBSITE_QUALITY_WEIGHTS,
  DEFAULT_BUSINESS_OPPORTUNITY_WEIGHTS,
  DEFAULT_LEAD_PRIORITY_WEIGHTS,
  DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS,
  DEFAULT_TARGET_CONFIG,
  WEBSITE_CLASSIFICATION_BANDS,
} from '../src/scoring/config';
import type { WebsiteInput } from '../src/scoring/website-input';
import type { WebsiteQualityWeights } from '../src/scoring/config';

const WSQ_WEIGHTS: WebsiteQualityWeights = {
  weights: DEFAULT_WEBSITE_QUALITY_WEIGHTS,
  sourceKey: 'test',
};
const BOS_WEIGHTS = { weights: DEFAULT_BUSINESS_OPPORTUNITY_WEIGHTS, sourceKey: 'test' };
const LP_WEIGHTS = { weights: DEFAULT_LEAD_PRIORITY_WEIGHTS, sourceKey: 'test' };

const TARGET_TX = { ...DEFAULT_TARGET_CONFIG, states: ['TX'] };

/** A strong fixture website: full, modern, contactable, NAP-consistent. */
function strongWebsite(): WebsiteInput {
  return {
    url: 'https://austinplumbingpros.com',
    pages: [
      {
        url: 'https://austinplumbingpros.com',
        httpStatus: 200,
        html: `<html><head>
          <title>Austin Plumbing Pros - 24/7 Emergency Plumber</title>
          <meta name="description" content="Trusted Austin plumbers. Water heater, drain, sewer repair. Call now for a free quote.">
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head><body>
          <h1>Austin Plumbing Pros</h1>
          <p>We fix leaks, drains, and water heaters fast. See our reviews and testimonials.</p>
          <img src="team.jpg"><img src="work.jpg"><img src="gallery3.jpg">
          <a href="tel:+15125551234">Call (512) 555-1234</a>
          <a href="/services">Services</a><a href="/about">About</a><a href="/contact">Contact</a>
          <form action="/contact"><input name="name"></form>
          <a href="mailto:hello@austinplumbingpros.com">Email us</a>
        </body></html>`,
        responseTimeMs: 300,
      },
      { url: 'https://austinplumbingpros.com/services', httpStatus: 200, html: '<h1>Services</h1>' },
    ],
    observedBusinessName: 'Austin Plumbing Pros',
    observedPhone: '+15125551234',
    observedAddress: '100 Main St, Austin TX',
  };
}

/** A weak fixture website: no meta, no viewport, two h1s, no contacts. */
function weakWebsite(): WebsiteInput {
  return {
    url: 'http://oldsite.example.com',
    pages: [
      {
        url: 'http://oldsite.example.com',
        httpStatus: 200,
        html: `<html><head><title>Untitled</title></head>
          <body><h1>Home</h1><h1>Second H1</h1><p>hi</p></body></html>`,
      },
    ],
  };
}

describe('website quality engine', () => {
  it('(1) NO_WEBSITE → WSQ 0, classification NO_WEBSITE', () => {
    const r = scoreNoWebsite();
    expect(r.websiteQualityScore).toBe(0);
    expect(r.classification).toBe('NO_WEBSITE');
    expect(r.categoryScores).toEqual({
      conversion: 0, mobile: 0, content: 0, trust: 0, technical: 0, design_ux: 0,
    });
    expect(r.testResults).toHaveLength(0);
    expect(r.criticalFailures).toHaveLength(0);
  });

  it('(2a) strong fixture website scores high, classification EXCELLENT', () => {
    const r = analyzeWebsite(strongWebsite(), { weights: WSQ_WEIGHTS });
    expect(r.websiteQualityScore).toBeGreaterThanOrEqual(WEBSITE_CLASSIFICATION_BANDS.excellent_min);
    expect(r.classification).toBe('EXCELLENT');
    // Conversion category is driven by the conversion_quality subjective eval.
    expect(r.categoryScores.conversion).toBeGreaterThanOrEqual(60);
  });

  it('(2b) weak fixture website scores low, classification VERY_WEAK', () => {
    const r = analyzeWebsite(weakWebsite(), { weights: WSQ_WEIGHTS });
    expect(r.websiteQualityScore).toBeLessThan(WEBSITE_CLASSIFICATION_BANDS.weak_min);
    expect(r.classification).toBe('VERY_WEAK');
  });

  it('(2c) strong scores strictly higher than weak', () => {
    const strong = analyzeWebsite(strongWebsite(), { weights: WSQ_WEIGHTS });
    const weak = analyzeWebsite(weakWebsite(), { weights: WSQ_WEIGHTS });
    expect(strong.websiteQualityScore).toBeGreaterThan(weak.websiteQualityScore);
    expect(strong.categoryScores.mobile).toBeGreaterThan(weak.categoryScores.mobile);
    expect(strong.categoryScores.technical).toBeGreaterThan(weak.categoryScores.technical);
  });

  it('(2d) classification bands land correctly at boundaries', () => {
    expect(classifyWebsiteScore(90)).toBe('EXCELLENT');
    expect(classifyWebsiteScore(75)).toBe('GOOD');
    expect(classifyWebsiteScore(60)).toBe('AVERAGE');
    expect(classifyWebsiteScore(40)).toBe('WEAK');
    expect(classifyWebsiteScore(0)).toBe('VERY_WEAK');
  });

  it('(3a) deterministic checks return evidence strings', () => {
    const tech = runTechnicalChecks(strongWebsite());
    const https = tech.outcomes.find((o) => o.checkId === 'has_https')!;
    expect(https.result).toBe('PASS');
    expect(https.evidence.some((e) => e.includes('https://austinplumbingpros.com'))).toBe(true);
    // Every outcome carries at least one evidence string.
    for (const o of tech.outcomes) {
      expect(Array.isArray(o.evidence) && o.evidence.length >= 1).toBe(true);
    }
  });

  it('(3b) a check that cannot run is NOT_RUN, never fabricated', () => {
    // No responseTimeMs → page speed proxy is honestly NOT_RUN.
    const noTiming = weakWebsite();
    expect(noTiming.pages[0]!.responseTimeMs).toBeUndefined();
    const tech = runTechnicalChecks(noTiming);
    const speed = tech.outcomes.find((o) => o.checkId === 'page_speed_proxy')!;
    expect(speed.result).toBe('NOT_RUN');
    expect(speed.evidence.some((e) => e.includes('not measured'))).toBe(true);
  });

  it('(3c) non-2xx HTTP status fails the http check (observed, not invented)', () => {
    const tech = runTechnicalChecks({
      url: 'https://down.com',
      pages: [{ url: 'https://down.com', httpStatus: 503 }],
    });
    expect(tech.outcomes.find((o) => o.checkId === 'has_http_ok')!.result).toBe('FAIL');
    expect(tech.outcomes.find((o) => o.checkId === 'has_http_ok')!.evidence.some((e) => e.includes('503'))).toBe(true);
  });

  it('(4) fallback subjective evaluator is deterministic and evidence-backed', () => {
    const ev = new DeterministicFallbackEvaluator();
    const inputs = {
      hasCompanyInfo: true,
      hasReviewsMention: true,
      contentLength: 400,
      hasCta: true,
      hasNap: true,
      hasGallery: true,
      title: 'Austin Plumbing Pros',
      url: 'https://austinplumbingpros.com',
    };
    const a = ev.evaluate('trust_presentation', inputs);
    const b = ev.evaluate('trust_presentation', inputs);
    expect(a.score).toBe(b.score); // deterministic
    expect(a.evidence.length).toBeGreaterThanOrEqual(6);
    expect(a.evidence.some((e) => e.includes('reviews mentioned: true'))).toBe(true);
    expect(a.model).toBe('deterministic-fallback');
    expect(a.promptRef).toBe('deterministic-fallback:v1');
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(100);
    // Same inputs → same full result object shape (score + evidence identical).
    expect(a.score).toBe(ev.evaluate('trust_presentation', { ...inputs }).score);
  });
});

describe('business opportunity engine', () => {
  it('(5a) different business signals yield different scores', () => {
    const strong = scoreOpportunity(
      {
        industry: 'plumbing',
        state: 'TX',
        business_status: 'OPERATIONAL',
        has_nap: true,
        rating: 4.5,
        review_count: 120,
        services: ['water heater', 'drain cleaning'],
        business_description: 'Sewer and leak repair',
        ability_signals: ['established 2010', 'consistent hours'],
        contactability_score: 80,
        has_phone: true,
        has_email: true,
      },
      { weights: BOS_WEIGHTS, target: TARGET_TX },
    );
    const bare = scoreOpportunity(
      { business_status: 'UNKNOWN' },
      { weights: BOS_WEIGHTS, target: TARGET_TX },
    );
    expect(strong.businessOpportunityScore).toBeGreaterThan(bare.businessOpportunityScore);
    expect(strong.categoryScores.viability).toBeGreaterThan(bare.categoryScores.viability);
  });

  it('(5b) absent signals are scored conservatively + recorded not-observed', () => {
    const r = scoreOpportunity(
      { business_status: 'UNKNOWN' },
      { weights: BOS_WEIGHTS, target: DEFAULT_TARGET_CONFIG },
    );
    // With no evidence at all the weighted score is at the floor.
    expect(r.businessOpportunityScore).toBe(0);
    for (const category of ['viability', 'demand', 'ability_to_pay', 'contactability', 'icp_fit']) {
      expect(r.evidence[category]!.some((e) => e.includes('not observed') || e.includes('conservatively'))).toBe(true);
    }
  });

  it('(5c) no invented facts: revenue/employees absent → ability_to_pay stays at the floor', () => {
    const r = scoreOpportunity(
      {
        industry: 'plumbing',
        business_status: 'OPERATIONAL',
        has_nap: true,
        rating: 4.0,
        review_count: 20,
        contactability_score: 70,
        has_phone: true,
      },
      { weights: BOS_WEIGHTS, target: DEFAULT_TARGET_CONFIG },
    );
    expect(r.categoryScores.ability_to_pay).toBe(0);
    expect(r.evidence.ability_to_pay![0]).toContain('not invented');
  });

  it('(5d) icp_fit reads target.* config from Settings', () => {
    // In-domain (plumbing) + in-state (TX) when target.states = ['TX'].
    const inTarget = scoreOpportunity(
      { industry: 'plumbing', state: 'TX', business_status: 'UNKNOWN' },
      { weights: BOS_WEIGHTS, target: TARGET_TX },
    );
    expect(inTarget.categoryScores.icp_fit).toBe(100);
    expect(inTarget.categoryVerdicts.find((v) => v.category === 'icp_fit')!.evidence.some((e) => e.includes('target.industries ["plumbing"]'))).toBe(true);

    // Out-of-target industry → 0, with evidence quoting the target list.
    const outIndustry = scoreOpportunity(
      { industry: 'roofing', state: 'TX', business_status: 'UNKNOWN' },
      { weights: BOS_WEIGHTS, target: TARGET_TX },
    );
    expect(outIndustry.categoryScores.icp_fit).toBe(50); // state still in target

    // Out-of-state when states are restricted.
    const outState = scoreOpportunity(
      { industry: 'plumbing', state: 'CA', business_status: 'UNKNOWN' },
      { weights: BOS_WEIGHTS, target: TARGET_TX },
    );
    expect(outState.categoryScores.icp_fit).toBe(50);
    expect(outState.categoryVerdicts.find((v) => v.category === 'icp_fit')!.evidence.some((e) => e.includes('NOT in target.states'))).toBe(true);

    // target.states empty = not restricted (partial credit for industry).
    const noStates = scoreOpportunity(
      { industry: 'plumbing', state: 'CA', business_status: 'UNKNOWN' },
      { weights: BOS_WEIGHTS, target: DEFAULT_TARGET_CONFIG },
    );
    expect(noStates.categoryScores.icp_fit).toBe(75);
  });
});

describe('lead priority engine', () => {
  it('(6) formula verified against a hand-computed example', () => {
    // Lead Priority = (100 - WSQ)*0.45 + BOS*0.40 + MarketFit*0.15
    //   WSQ=40, BOS=60, MF=50 → (60)*0.45 + (60)*0.40 + (50)*0.15
    //   = 27 + 24 + 7.5 = 58.5 → REVIEW (>=50, <65).
    const r = scoreLeadPriority(
      { websiteQualityScore: 40, businessOpportunityScore: 60, marketFitScore: 50 },
      { weights: LP_WEIGHTS, thresholds: DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS },
    );
    const expected = 60 * 0.45 + 60 * 0.4 + 50 * 0.15;
    expect(r.leadPriorityScore).toBeCloseTo(expected, 5);
    expect(r.leadPriorityScore).toBe(58.5);
    expect(r.classification).toBe('REVIEW');
    expect(r.inputs).toMatchObject({ websiteQualityScore: 40, businessOpportunityScore: 60, marketFitScore: 50 });
  });

  it('(6b) classification thresholds: 80+ HIGH, 65-79 SECONDARY, 50-64 REVIEW, <50 REJECT', () => {
    expect(classifyLeadPriority(80, DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS)).toBe('HIGH_PRIORITY');
    expect(classifyLeadPriority(79, DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS)).toBe('SECONDARY');
    expect(classifyLeadPriority(65, DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS)).toBe('SECONDARY');
    expect(classifyLeadPriority(64, DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS)).toBe('REVIEW');
    expect(classifyLeadPriority(50, DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS)).toBe('REVIEW');
    expect(classifyLeadPriority(49, DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS)).toBe('REJECT');
  });

  it('(6c) weights come from config; snapshot carries formula version + thresholds', () => {
    const r = scoreLeadPriority(
      { websiteQualityScore: 20, businessOpportunityScore: 80, marketFitScore: 90 },
      { weights: LP_WEIGHTS, thresholds: DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS },
    );
    expect(r.weights).toEqual(DEFAULT_LEAD_PRIORITY_WEIGHTS);
    expect(r.formulaVersion).toBe('scoring.lead_priority.formula');
    expect(r.thresholds).toEqual(DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS);
    // Hand check: 80*0.45 + 80*0.4 + 90*0.15 = 36 + 32 + 13.5 = 81.5 → HIGH_PRIORITY
    expect(r.leadPriorityScore).toBe(81.5);
    expect(r.classification).toBe('HIGH_PRIORITY');
  });

  it('(6d) out-of-range inputs are clamped to 0-100 (defensive)', () => {
    const r = scoreLeadPriority(
      { websiteQualityScore: -10, businessOpportunityScore: 130, marketFitScore: 500 },
      { weights: LP_WEIGHTS, thresholds: DEFAULT_LEAD_CLASSIFICATION_THRESHOLDS },
    );
    expect(r.inputs.websiteQualityScore).toBe(0);
    expect(r.inputs.businessOpportunityScore).toBe(100);
    expect(r.inputs.marketFitScore).toBe(100);
  });
});