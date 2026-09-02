/**
 * Unit tests for the pure rejection-rule evaluator. No DB involved: the
 * evaluator is a deterministic function of (attributes, context, config).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRejectionRules,
  hasTriggeredRules,
  type BusinessAttributes,
  type RejectionContext,
} from '../src/lifecycle/rejection-rules';
import { DEFAULT_REJECTION_RULE_CONFIG, type RejectionRuleConfig } from '../src/lifecycle/config';

const cfg: RejectionRuleConfig = DEFAULT_REJECTION_RULE_CONFIG;

/** A fully "healthy" lead that should trigger no rules. */
function healthyAttributes(overrides: Partial<BusinessAttributes> = {}): BusinessAttributes {
  return {
    industry: 'plumbing',
    state: 'TX',
    zip: '78701',
    business_status: 'OPERATIONAL',
    contactable: true,
    contactability_score: 80,
    ...overrides,
  };
}

function healthyContext(overrides: Partial<RejectionContext> = {}): RejectionContext {
  return {
    websiteQualityScore: 40,
    businessOpportunityScore: 70,
    websiteClassification: 'WEAK',
    icpMatch: true,
    doNotContactSignal: false,
    ...overrides,
  };
}

function reasonsOf(rules: ReturnType<typeof evaluateRejectionRules>): string[] {
  return rules.map((r) => r.reason);
}

describe('evaluateRejectionRules', () => {
  it('returns no rules for a healthy in-ICP lead with a weak website', () => {
    const rules = evaluateRejectionRules(healthyAttributes(), healthyContext(), cfg);
    expect(rules).toHaveLength(0);
    expect(hasTriggeredRules(rules)).toBe(false);
  });

  it('INACTIVE_BUSINESS fires when the business status is closed', () => {
    for (const status of ['CLOSED', 'PERMANENTLY_CLOSED', 'TEMPORARILY_CLOSED'] as const) {
      const rules = evaluateRejectionRules(
        healthyAttributes({ business_status: status }),
        healthyContext(),
        cfg,
      );
      expect(reasonsOf(rules)).toContain('INACTIVE_BUSINESS');
      expect(rules[0]!.detail.business_status).toBe(status);
    }
  });

  it('NO_CONTACT_ROUTE fires when there is no contact route at all', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes({ contactable: false }),
      healthyContext(),
      cfg,
    );
    expect(reasonsOf(rules)).toContain('NO_CONTACT_ROUTE');
  });

  it('NO_CONTACT_ROUTE fires when contactability is below the threshold', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes({ contactability_score: 20 }),
      healthyContext(),
      cfg,
    );
    expect(reasonsOf(rules)).toContain('NO_CONTACT_ROUTE');
    expect(rules[0]!.detail.min_contactability_score).toBe(40);
  });

  it('OUTSIDE_ICP fires when icpMatch is false', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes(),
      healthyContext({ icpMatch: false }),
      cfg,
    );
    expect(reasonsOf(rules)).toContain('OUTSIDE_ICP');
  });

  it('EXCELLENT_WEBSITE fires from an explicit classification', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes(),
      healthyContext({ websiteClassification: 'EXCELLENT' }),
      cfg,
    );
    expect(reasonsOf(rules)).toContain('EXCELLENT_WEBSITE');
  });

  it('EXCELLENT_WEBSITE fires from a score at/above the band when no classification is given', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes(),
      healthyContext({ websiteClassification: undefined, websiteQualityScore: 92 }),
      cfg,
    );
    expect(reasonsOf(rules)).toContain('EXCELLENT_WEBSITE');
  });

  it('EXCELLENT_WEBSITE does not fire below the band', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes(),
      healthyContext({ websiteClassification: undefined, websiteQualityScore: 89 }),
      cfg,
    );
    expect(reasonsOf(rules)).not.toContain('EXCELLENT_WEBSITE');
  });

  it('LOW_OPPORTUNITY fires below the pursuit threshold', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes(),
      healthyContext({ businessOpportunityScore: 49 }),
      cfg,
    );
    expect(reasonsOf(rules)).toContain('LOW_OPPORTUNITY');
  });

  it('LOW_OPPORTUNITY does not fire at/above the threshold', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes(),
      healthyContext({ businessOpportunityScore: 50 }),
      cfg,
    );
    expect(reasonsOf(rules)).not.toContain('LOW_OPPORTUNITY');
  });

  it('renders a deterministic ordered combination of all five fired rules', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes({
        business_status: 'CLOSED',
        contactable: false,
        contactability_score: 10,
      }),
      healthyContext({
        icpMatch: false,
        websiteClassification: 'EXCELLENT',
        businessOpportunityScore: 20,
      }),
      cfg,
    );
    expect(reasonsOf(rules)).toEqual([
      'OUTSIDE_ICP',
      'INACTIVE_BUSINESS',
      'NO_CONTACT_ROUTE',
      'EXCELLENT_WEBSITE',
      'LOW_OPPORTUNITY',
    ]);
    expect(hasTriggeredRules(rules)).toBe(true);
  });

  it('null scores never fire rules (unknown is not evidence)', () => {
    const rules = evaluateRejectionRules(
      healthyAttributes({ contactability_score: null }),
      healthyContext({ websiteQualityScore: null, businessOpportunityScore: null, icpMatch: null }),
      cfg,
    );
    expect(rules).toHaveLength(0);
  });

  it('respects config threshold overrides (excellent_website_min lowered)', () => {
    const lowered: RejectionRuleConfig = { ...cfg, excellent_website_min: 75 };
    const rules = evaluateRejectionRules(
      healthyAttributes(),
      healthyContext({ websiteClassification: undefined, websiteQualityScore: 80 }),
      lowered,
    );
    expect(reasonsOf(rules)).toContain('EXCELLENT_WEBSITE');
  });

  it('respects config threshold overrides (min_opportunity_score raised)', () => {
    const raised: RejectionRuleConfig = { ...cfg, min_opportunity_score: 70 };
    const rules = evaluateRejectionRules(
      healthyAttributes(),
      healthyContext({ businessOpportunityScore: 60 }),
      raised,
    );
    expect(reasonsOf(rules)).toContain('LOW_OPPORTUNITY');
  });
});