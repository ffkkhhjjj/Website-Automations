/**
 * LEAD PRIORITY SCORE ENGINE — weighted composite + classification.
 *
 * Formula (weights from system_settings scoring.lead_priority.formula, seeded
 * v1): lead_priority = (100 - WSQ)*0.45 + BOS*0.40 + MarketFit*0.15
 *
 * MarketFit is a 0-100 input: by default the pipeline passes the icp_fit
 * category score from the business-opportunity run (documented); callers may
 * pass their own market-fit score explicitly.
 *
 * Classification thresholds from system_settings scoring.lead_classification.thresholds:
 *   >=80 HIGH_PRIORITY, >=65 SECONDARY, >=50 REVIEW, <50 REJECT.
 *
 * Pure computation — the orchestrator persists ONE row per run (history kept).
 */
import type { LeadPriorityWeights } from './config.js';
import type { LeadClassification } from './types.js';

export interface LeadPriorityInput {
  websiteQualityScore: number; // 0-100 (from the WSQ engine; 0 for NO_WEBSITE)
  businessOpportunityScore: number; // 0-100
  /** 0-100. Default source: icp_fit category from the BOS run. Callers may
   *  pass their own market-fit score explicitly. Inputs are clamped to 0-100
   *  for the computation AND the persisted snapshot. */
  marketFitScore?: number;
}

export interface LeadPriorityResult {
  leadPriorityScore: number;
  classification: LeadClassification;
  inputs: LeadPriorityInput & { marketFitScore: number };
  weights: Record<string, number>;
  formulaVersion: string;
  thresholds: {
    high_priority_min: number;
    secondary_min: number;
    review_min: number;
  };
}

export function scoreLeadPriority(
  input: LeadPriorityInput,
  opts: {
    weights: LeadPriorityWeights;
    thresholds: { high_priority_min: number; secondary_min: number; review_min: number };
  },
): LeadPriorityResult {
  const wsq = clamp(input.websiteQualityScore, 0, 100);
  const bos = clamp(input.businessOpportunityScore, 0, 100);
  const marketFit = clamp(input.marketFitScore ?? 0, 0, 100);
  const { weights } = opts.weights;
  const w = {
    website_quality: num(weights.website_quality),
    business_opportunity: num(weights.business_opportunity),
    market_fit: num(weights.market_fit),
  };
  const priority =
    (100 - wsq) * w.website_quality + bos * w.business_opportunity + marketFit * w.market_fit;
  const leadPriorityScore = Math.round(priority * 100) / 100;
  const classification = classifyLeadPriority(leadPriorityScore, opts.thresholds);
  return {
    leadPriorityScore,
    classification,
    // Record the CLAMPED inputs in the snapshot: the DB CHECK constraints
    // require 0-100, so storing a raw -10/130 would be unrepresentable.
    inputs: { websiteQualityScore: wsq, businessOpportunityScore: bos, marketFitScore: marketFit },
    weights: { ...weights },
    formulaVersion: 'scoring.lead_priority.formula',
    thresholds: { ...opts.thresholds },
  };
}

/** Lead classification from priority score + configurable thresholds. */
export function classifyLeadPriority(
  score: number,
  thresholds: { high_priority_min: number; secondary_min: number; review_min: number },
): LeadClassification {
  if (score >= thresholds.high_priority_min) return 'HIGH_PRIORITY';
  if (score >= thresholds.secondary_min) return 'SECONDARY';
  if (score >= thresholds.review_min) return 'REVIEW';
  return 'REJECT';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}