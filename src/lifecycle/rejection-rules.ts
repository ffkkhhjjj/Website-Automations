/**
 * AUTOMATED REJECTION RULES — deterministic, pure evaluator.
 *
 * Given a business's current data plus a context of observed values (website
 * score, opportunity score, contactability, operational status, ICP match,
 * flags), returns the list of triggered rejection reasons. The evaluator never
 * touches the DB and never mutates anything: it is a pure function of its
 * inputs. Thresholds come from RejectionRuleConfig (read from system_settings
 * with conservative master-spec defaults); the scoring engines themselves are a
 * later brief, so scores are accepted as inputs here (typed), not computed.
 *
 * Rule list (master spec):
 *  - INACTIVE_BUSINESS      business status is closed/temporarily closed
 *  - NO_CONTACT_ROUTE       no verified contact route (email/phone), or low
 *                           contactability
 *  - OUTSIDE_ICP            industry/state is outside the target ICP
 *  - EXCELLENT_WEBSITE      website quality score >= excellent threshold (90)
 *  - LOW_OPPORTUNITY        business opportunity score below the pursuit
 *                           threshold (lead classification REJECT band)
 *
 * Extra explicit/manual reasons (OPT_OUT, DO_NOT_CONTACT_REQUEST, BAD_DATA,
 * DUPLICATE, OTHER) are recorded through the rejection service — they are not
 * produced by this evaluator because they come from human/owner signals or
 * pipeline events, not from scored attributes.
 */
import type { BusinessOperationalStatus, RejectionReason } from './types.js';
import type { RejectionRuleConfig } from './config.js';

/** Business attributes the rules can look at (subset of the businesses row). */
export interface BusinessAttributes {
  industry: string | null;
  state: string | null;
  zip: string | null;
  business_status: BusinessOperationalStatus | null;
  /** Best verified contact route on file (email or phone). */
  contactable: boolean;
  /** contactability_score from businesses/contacts (0–100). */
  contactability_score: number | null;
}

/** Observed/datapoint values relevant to the rules (scored elsewhere). */
export interface RejectionContext {
  websiteQualityScore: number | null; // 0–100; null when not yet analyzed
  businessOpportunityScore: number | null; // 0–100; null when not yet scored
  /** set when the website was classified by the (later) scoring engine */
  websiteClassification?: 'EXCELLENT' | 'GOOD' | 'AVERAGE' | 'WEAK' | 'VERY_WEAK' | 'NO_WEBSITE';
  /** ICP match flags (later scoring brief) */
  icpMatch?: boolean | null;
  /** Explicit opt-out / do-not-contact signal (e.g. reply classifier, prospect request) */
  doNotContactSignal?: boolean;
}

/** A single triggered rejection outcome. */
export interface TriggeredRule {
  reason: RejectionReason;
  /** Human-readable detail recorded in the rejections table for analytics. */
  detail: Record<string, unknown>;
}

/** Triggered rejection reasons in a deterministic order (evaluator contract). */
const ORDER: readonly RejectionReason[] = [
  'OUTSIDE_ICP',
  'INACTIVE_BUSINESS',
  'NO_CONTACT_ROUTE',
  'EXCELLENT_WEBSITE',
  'LOW_OPPORTUNITY',
];

/**
 * Pure evaluator: compute the rejection rules triggered by the given business
 * attributes + context. Returns [] when no rule fires. Never throws (nulls are
 * treated as "no evidence" → rule does not fire).
 */
export function evaluateRejectionRules(
  attributes: BusinessAttributes,
  context: RejectionContext,
  config: RejectionRuleConfig,
): TriggeredRule[] {
  const triggered: TriggeredRule[] = [];

  // OUTSIDE_ICP — deterministic target definition. Industry/state/zips are
  // resolved by the ICP config (target.industries / target.states), which is
  // applied upstream; here we treat a non-null industry outside the target as
  // the signal (a null industry is unknown, not yet evidence of a mismatch).
  if (context.icpMatch === false) {
    triggered.push({
      reason: 'OUTSIDE_ICP',
      detail: { icpMatch: false },
    });
  }

  // INACTIVE_BUSINESS — closed / temporarily closed statuses.
  if (
    attributes.business_status !== null &&
    config.inactive_statuses.includes(attributes.business_status)
  ) {
    triggered.push({
      reason: 'INACTIVE_BUSINESS',
      detail: { business_status: attributes.business_status },
    });
  }

  // NO_CONTACT_ROUTE — no verified email/phone at all, or a low contactability score.
  const lowContactability =
    attributes.contactability_score !== null &&
    attributes.contactability_score < config.min_contactability_score;
  if (!attributes.contactable || lowContactability) {
    triggered.push({
      reason: 'NO_CONTACT_ROUTE',
      detail: {
        contactable: attributes.contactable,
        contactability_score: attributes.contactability_score,
        min_contactability_score: config.min_contactability_score,
      },
    });
  }

  // EXCELLENT_WEBSITE — explicit classification, or a score at/above the band.
  const websiteIsExcellent =
    context.websiteClassification === 'EXCELLENT' ||
    (context.websiteClassification === undefined &&
      context.websiteQualityScore !== null &&
      context.websiteQualityScore >= config.excellent_website_min);
  if (websiteIsExcellent) {
    triggered.push({
      reason: 'EXCELLENT_WEBSITE',
      detail: {
        website_quality_score: context.websiteQualityScore,
        website_classification: context.websiteClassification ?? null,
        excellent_website_min: config.excellent_website_min,
      },
    });
  }

  // LOW_OPPORTUNITY — opportunity score below the pursuit threshold.
  if (
    context.businessOpportunityScore !== null &&
    context.businessOpportunityScore < config.min_opportunity_score
  ) {
    triggered.push({
      reason: 'LOW_OPPORTUNITY',
      detail: {
        business_opportunity_score: context.businessOpportunityScore,
        min_opportunity_score: config.min_opportunity_score,
      },
    });
  }

  // Deterministic output order → stable dedup + predictable tests.
  const seen = new Set<RejectionReason>();
  const sorted: TriggeredRule[] = [];
  for (const reason of ORDER) {
    const idx = triggered.findIndex((t) => t.reason === reason);
    if (idx !== -1) {
      seen.add(reason);
      sorted.push(triggered[idx]!);
    }
  }
  // Reasons not in ORDER (e.g. OPT_OUT/DO_NOT_CONTACT_REQUEST handled by the
  // rejection service, not this evaluator) are appended in input order.
  for (const t of triggered) {
    if (!seen.has(t.reason)) sorted.push(t);
  }
  return sorted;
}

/** True when the evaluator returned at least one rule. */
export function hasTriggeredRules(rules: TriggeredRule[]): boolean {
  return rules.length > 0;
}