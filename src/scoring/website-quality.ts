/**
 * WEBSITE QUALITY SCORE ENGINE — deterministic + AI-ready-subjective.
 *
 * Analysis flow (one run):
 *  1. NO_WEBSITE → score 0, classification NO_WEBSITE (nothing else).
 *  2. Deterministic technical checks run against the observed WebsiteInput —
 *     every check reports evidence (observed URLs/snippets/status codes).
 *  3. Subjective categories (clarity, copy, visual, trust, conversion) are
 *     evaluated through the AiSubjectiveEvaluator interface. The shipped
 *     DeterministicFallbackEvaluator derives them from objective signals;
 *     a real AI evaluator is a later drop-in behind the same interface.
 *  4. Category scores are weighted (weights from system_settings +
 *     scoring_versions active version) → WSQ 0-100 and a classification band.
 *
 * Pure computation — no DB access here. The orchestrator persists the run.
 */
import {
  WEBSITE_CLASSIFICATION_BANDS,
  type WebsiteQualityWeights,
} from './config.js';
import { runTechnicalChecks, extractSignals, type TechnicalCheckSet } from './website-checks.js';
import type { WebsiteInput } from './website-input.js';
import {
  DEFAULT_EVALUATOR,
  SUBJECTIVE_CATEGORIES,
  type AiSubjectiveEvaluator,
  type SubjectiveEvaluation,
  type SubjectiveInputs,
} from './subjective.js';
import type { CategoryScores } from '../db/schema.js';
import type { WebsiteClassification, CategoryVerdict } from './types.js';

/** A website-quality category verdict (shared verdict + score source). */
export interface WebsiteCategoryVerdict extends CategoryVerdict {
  /** source of the score: 'technical-checks' | evaluator model name. */
  source: string;
  promptRef?: string;
}

export interface WebsiteQualityResult {
  websiteQualityScore: number;
  classification: WebsiteClassification;
  categoryScores: CategoryScores;
  categoryVerdicts: WebsiteCategoryVerdict[];
  /** Per-check outcomes (deterministic technical half). */
  testResults: TechnicalCheckSet['outcomes'];
  /** Human+AI-readable evidence for every score (technical + subjective). */
  evidence: Record<string, unknown>;
  criticalFailures: unknown[];
}

/** A website with no observed site → WSQ 0 / NO_WEBSITE. */
export function scoreNoWebsite(): WebsiteQualityResult {
  const zeros: CategoryScores = {
    conversion: 0,
    mobile: 0,
    content: 0,
    trust: 0,
    technical: 0,
    design_ux: 0,
  };
  return {
    websiteQualityScore: 0,
    classification: 'NO_WEBSITE',
    categoryScores: zeros,
    categoryVerdicts: [],
    testResults: [],
    evidence: { note: 'no website observed for this business' },
    criticalFailures: [],
  };
}

/** Run the full website quality analysis (deterministic + subjective). */
export function analyzeWebsite(
  input: WebsiteInput,
  opts: {
    weights: WebsiteQualityWeights;
    evaluator?: AiSubjectiveEvaluator;
  },
): WebsiteQualityResult {
  const evaluator = opts.evaluator ?? DEFAULT_EVALUATOR;
  const tech = runTechnicalChecks(input);
  const verdicts: WebsiteCategoryVerdict[] = [];

  // 1. Technical category (deterministic).
  verdicts.push({
    category: 'technical',
    score: tech.technicalScore,
    evidence: tech.outcomes.flatMap((o) => o.evidence),
    source: 'technical-checks',
  });

  // 2. Subjective categories through the evaluator interface.
  const signals = extractSignals(input);
  const home = signals[0];
  const pageHasGallery = (input.pages[0]?.html?.match(/<img\b/g)?.length ?? 0) >= 2;
  const subjectiveInputs: SubjectiveInputs = {
    hasCompanyInfo: Boolean(input.observedBusinessName || input.observedAddress),
    hasReviewsMention: /(review|testimonial)/i.test(input.pages[0]?.html ?? ''),
    contentLength: home?.wordCount ?? 0,
    hasCta: tech.outcomes.find((o) => o.checkId === 'has_cta')?.result === 'PASS',
    hasNap: tech.outcomes.find((o) => o.checkId === 'has_nap')?.result === 'PASS',
    hasGallery: pageHasGallery,
    title: home?.title,
    url: input.url,
  };
  const subjective: SubjectiveEvaluation[] = SUBJECTIVE_CATEGORIES.map((c) =>
    evaluator.evaluate(c, subjectiveInputs),
  );
  for (const s of subjective) {
    verdicts.push({
      category: s.category,
      score: s.score,
      evidence: s.evidence,
      source: evaluator.name,
      promptRef: s.promptRef,
    });
  }

  // 3. Weighted total.
  const { weights } = opts.weights;
  const conversionScore = subjective.find((s) => s.category === 'conversion_quality')?.score ?? 0;
  const copyScore = categoryOf(verdicts, 'copy_quality');
  const clarityScore = categoryOf(verdicts, 'clarity');
  const categoryScores: CategoryScores = {
    conversion: conversionScore,
    mobile: requireFeatureScore(tech, 'has_viewport'),
    content: averageOf([copyScore, clarityScore]),
    trust: categoryOf(verdicts, 'trust_presentation'),
    technical: tech.technicalScore,
    design_ux: categoryOf(verdicts, 'visual_quality'),
  };
  const total = Number(
    (
      (categoryScores.conversion * num(weights.conversion)) +
      (categoryScores.mobile * num(weights.mobile)) +
      (categoryScores.content * num(weights.content)) +
      (categoryScores.trust * num(weights.trust)) +
      (categoryScores.technical * num(weights.technical)) +
      (categoryScores.design_ux * num(weights.design_ux))
    ) / 100,
  );
  const websiteQualityScore = Math.round(clamp(total, 0, 100));

  return {
    websiteQualityScore,
    classification: classifyWebsiteScore(websiteQualityScore),
    categoryScores,
    categoryVerdicts: verdicts,
    testResults: tech.outcomes,
    evidence: {
      technical: tech.outcomes.map((o) => ({ checkId: o.checkId, result: o.result, evidence: o.evidence })),
      subjective: subjective.map((s) => ({ category: s.category, score: s.score, evidence: s.evidence })),
    },
    criticalFailures: tech.outcomes
      .filter((o) => o.result === 'FAIL')
      .map((o) => ({ checkId: o.checkId, evidence: o.evidence })),
  };
}

/** Website classification bands (spec, fixed). */
export function classifyWebsiteScore(score: number): WebsiteClassification {
  if (score >= WEBSITE_CLASSIFICATION_BANDS.excellent_min) return 'EXCELLENT';
  if (score >= WEBSITE_CLASSIFICATION_BANDS.good_min) return 'GOOD';
  if (score >= WEBSITE_CLASSIFICATION_BANDS.average_min) return 'AVERAGE';
  if (score >= WEBSITE_CLASSIFICATION_BANDS.weak_min) return 'WEAK';
  return 'VERY_WEAK';
}

/* --- helpers -------------------------------------------------------------- */

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function categoryOf(verdicts: CategoryVerdict[], category: string): number {
  return verdicts.find((v) => v.category === category)?.score ?? 0;
}

function requireFeatureScore(tech: TechnicalCheckSet, checkId: string): number {
  const o = tech.outcomes.find((c) => c.checkId === checkId);
  if (!o) throw new Error(`missing technical check ${checkId}`);
  return o.result === 'PASS' ? 100 : 0;
}

function averageOf(values: number[]): number {
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}