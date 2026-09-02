/**
 * BUSINESS OPPORTUNITY SCORE ENGINE — deterministic, evidence-backed.
 *
 * Weights (seeded v1): viability 25 / demand 25 / ability_to_pay 20 /
 * contactability 20 / icp_fit 10. All category scores derive ONLY from real,
 * provided business signals. Where a signal is absent it is scored
 * conservatively and the evidence records "not observed" — the engine NEVER
 * invents revenue, employee counts, business age, licenses, or any other fact.
 *
 * Pure computation — the orchestrator persists results to lead_scores.
 */
import type { TargetConfig, BusinessOpportunityWeights } from './config.js';
import type { BusinessOperationalStatus, CategoryVerdict } from './types.js';

/** Business signals the BOS engine may look at (subset of the businesses row).
 *  Every field is genuinely provided data; optional fields may be absent. */
export interface OpportunityInput {
  industry?: string | null;
  state?: string | null;
  business_status?: BusinessOperationalStatus | null;
  has_nap?: boolean; // name/address/phone present (typically from enrichment)
  rating?: number | null; // 0-5
  review_count?: number | null;
  services?: string[] | null;
  business_description?: string | null;
  /** Regularity-of-business evidence (e.g. observed years in operation,
   *  consistent hours) — only what was actually provided. */
  ability_signals?: string[] | null;
  contactability_score?: number | null;
  has_phone?: boolean;
  has_email?: boolean;
  has_contact_route?: boolean;
}

export interface BusinessOpportunityResult {
  businessOpportunityScore: number;
  categoryScores: Record<string, number>;
  categoryVerdicts: CategoryVerdict[];
  /** Which evidence was absent → scored conservatively ("not observed"). */
  evidence: Record<string, string[]>;
}

/** Category weight map (shared with the orchestrator for snapshotting). */
export type BOSCategories =
  | 'viability'
  | 'demand'
  | 'ability_to_pay'
  | 'contactability'
  | 'icp_fit';

/** Score the business opportunity from provided signals. Deterministic. */
export function scoreOpportunity(
  input: OpportunityInput,
  opts: {
    weights: BusinessOpportunityWeights;
    target: TargetConfig;
  },
): BusinessOpportunityResult {
  const verdicts: CategoryVerdict[] = [];
  const evidence: Record<string, string[]> = {};
  const record = (category: string, lines: string[]): void => {
    evidence[category] = (evidence[category] ?? []).concat(lines);
  };

  // --- viability (25) -----------------------------------------------------
  let viability = 0;
  const viab: string[] = [];
  if (input.business_status) {
    if (input.business_status === 'OPERATIONAL') {
      viability += 45;
      viab.push(`business status: OPERATIONAL`);
    } else {
      viab.push(`business status: ${input.business_status} (inactive → viability floor)`);
    }
  } else {
    viab.push('business status not observed — scored conservatively');
  }
  if (input.has_nap) {
    viability += 25;
    viab.push('NAP (name/address/phone) present');
  } else {
    viab.push('NAP not observed — scored conservatively');
  }
  if (typeof input.review_count === 'number' && input.review_count > 0) {
    viability += 15;
    viab.push(`review count: ${input.review_count}`);
  } else {
    viab.push('review count not observed — scored conservatively');
  }
  if (typeof input.rating === 'number' && input.rating > 0) {
    viability += 15;
    viab.push(`rating: ${input.rating}/5`);
  } else {
    viab.push('rating not observed — scored conservatively');
  }
  record('viability', viab);
  verdicts.push({ category: 'viability', score: viability, evidence: viab });

  // --- demand (25) --------------------------------------------------------
  // Service/category keyword presence derived from provided services +
  // business_description only. Industry vertical defaults provide a floor.
  const demandKeywords = [
    'plumbing',
    'water heater',
    'drain',
    'sewer',
    'leak',
    'pipe',
    'bathroom remodel',
    'kitchen remodel',
    'toilet',
    'emergency',
    '24/7',
    'installation',
    'repair',
  ];
  let demand = 0;
  const dem: string[] = [];
  const text = [
    ...(input.services ?? []),
    input.business_description ?? '',
  ].join(' ').toLowerCase();
  const hits = demandKeywords.filter((k) => text.includes(k));
  const isTargetIndustry = input.industry?.toLowerCase().trim() === 'plumbing';
  if (isTargetIndustry) {
    demand += 50;
    dem.push('industry is a platform target vertical (plumbing)');
  }
  demand += Math.min(50, hits.length * 10);
  if (hits.length > 0) dem.push(`service keywords observed: ${hits.join(', ')}`);
  else dem.push('no service keywords observed in provided services/description — scored conservatively');
  record('demand', dem);
  verdicts.push({ category: 'demand', score: demand, evidence: dem });

  // --- ability_to_pay (20) -----------------------------------------------
  // Only regularity-of-business signals IF provided. No revenue/employee
  // count/age/license fabrication — absent signals score the floor.
  let ability = 0;
  const abil: string[] = [];
  const signals = input.ability_signals ?? [];
  if (signals.length > 0) {
    ability = Math.min(100, 40 + signals.length * 20);
    abil.push(`regularity-of-business signals provided: ${signals.join('; ')}`);
  } else {
    abil.push('no ability-to-pay signals provided (revenue/employees not invented) — scored conservatively');
  }
  record('ability_to_pay', abil);
  verdicts.push({ category: 'ability_to_pay', score: ability, evidence: abil });

  // --- contactability (20) ------------------------------------------------
  const contactable =
    input.has_contact_route === true ||
    Boolean(input.has_phone) ||
    Boolean(input.has_email) ||
    (typeof input.contactability_score === 'number' && input.contactability_score >= 40);
  let contactability = 0;
  const cont: string[] = [];
  if (typeof input.contactability_score === 'number' && input.contactability_score > 0) {
    contactability = Math.round(input.contactability_score * 0.6);
    cont.push(`businesses.contactability_score observed: ${input.contactability_score}`);
  }
  if (input.has_phone || input.has_email || input.has_contact_route) {
    contactability += 40;
    cont.push(
      [
        input.has_contact_route === true ? 'contact route on file' : null,
        input.has_phone ? 'phone on file' : null,
        input.has_email ? 'email on file' : null,
      ].filter(Boolean).join(', '),
    );
  }
  if (!contactable) cont.push('no contact route observed — scored conservatively');
  contactability = clamp(contactability, 0, 100);
  record('contactability', cont);
  verdicts.push({ category: 'contactability', score: contactability, evidence: cont });

  // --- icp_fit (10) -------------------------------------------------------
  const target = opts.target;
  let icp = 0;
  const icpE: string[] = [];
  const industryIn = input.industry?.toLowerCase().trim() ?? null;
  if (industryIn && target.industries.includes(industryIn)) {
    icp += 50;
    icpE.push(`industry ${industryIn} in target.industries ${JSON.stringify(target.industries)}`);
  } else if (industryIn) {
    icpE.push(`industry ${industryIn} NOT in target.industries ${JSON.stringify(target.industries)}`);
  } else {
    icpE.push('industry not observed — scored conservatively');
  }
  const stateIn = input.state?.toUpperCase().trim() ?? null;
  if (stateIn && target.states.includes(stateIn)) {
    icp += 50;
    icpE.push(`state ${stateIn} in target.states ${JSON.stringify(target.states)}`);
  } else if (stateIn && target.states.length > 0) {
    icpE.push(`state ${stateIn} NOT in target.states (target.states configured: ${JSON.stringify(target.states)})`);
  } else if (stateIn) {
    icp += 25; // target.states empty = not restricted (Settings-configured)
    icpE.push(`state ${stateIn} — target.states unset, not restricted`);
  } else {
    icpE.push('state not observed — scored conservatively');
  }
  record('icp_fit', icpE);
  verdicts.push({ category: 'icp_fit', score: icp, evidence: icpE });

  // --- weighted total -----------------------------------------------------
  const { weights } = opts.weights;
  const scores: Record<string, number> = {
    viability,
    demand,
    ability_to_pay: ability,
    contactability,
    icp_fit: icp,
  };
  const businessOpportunityScore = Math.round(
    verdicts.reduce(
      (acc, v) =>
        acc + v.score * (typeof weights[v.category] === 'number' ? weights[v.category]! : 0),
      0,
    ) / 100,
  );

  return {
    businessOpportunityScore,
    categoryScores: scores,
    categoryVerdicts: verdicts,
    evidence,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}