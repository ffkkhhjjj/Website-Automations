/**
 * SUBJECTIVE EVALUATION INTERFACE — the AI-ready seam of website quality.
 *
 * Master spec: AI may evaluate SUBJECTIVE areas (clarity, copy quality, visual
 * quality, trust presentation, conversion quality) and MUST provide evidence
 * for every subjective conclusion. Technical measurements stay deterministic.
 *
 * This file defines the interface an AI evaluator must implement (a later
 * integrations brief wires a real provider behind it) and ships a
 * DeterministicFallbackEvaluator that derives the same five categories from
 * objective signals with a documented mapping — so the pipeline is fully
 * functional today with zero AI, and a real AI evaluator becomes a drop-in
 * later. Both return the exact same shape.
 *
 * No fake integration: an AI evaluator is only "used" when the config
 * (ai.evaluator.provider/model/prompt + AI_EVALUATOR_API_* env) is present.
 */

/** A subjective category the evaluator can be asked about. */
export type SubjectiveCategory =
  | 'clarity'
  | 'copy_quality'
  | 'visual_quality'
  | 'trust_presentation'
  | 'conversion_quality';

export const SUBJECTIVE_CATEGORIES: readonly SubjectiveCategory[] = [
  'clarity',
  'copy_quality',
  'visual_quality',
  'trust_presentation',
  'conversion_quality',
];

/** Objective signals a subjective evaluator may look at (all observable). */
export interface SubjectiveInputs {
  /** Business name observed on the site (truthful NAP presence). */
  hasCompanyInfo: boolean;
  /** Reviews/testimonials mentioned anywhere on the site. */
  hasReviewsMention: boolean;
  /** Approx. word count of the home page text (observed). */
  contentLength: number;
  /** A clear call-to-action observed. */
  hasCta: boolean;
  /** NAP consistency signals observed (name+phone). */
  hasNap: boolean;
  /** A photo/gallery (img tags / gallery markup) observed. */
  hasGallery: boolean;
  /** The observed home-page title, for evidence strings. */
  title?: string;
  /** The URL analyzed, for evidence strings. */
  url?: string;
}

export interface SubjectiveEvaluation {
  category: SubjectiveCategory;
  /** 0-100. */
  score: number;
  /** The exact observations behind the score (quotes, URLs, counts). */
  evidence: string[];
  /** Which evaluator produced this score. */
  model: 'deterministic-fallback' | string;
  /** Prompt/config key used (stable reference for auditing + futures). */
  promptRef: string;
}

/** Contract every subjective evaluator (AI or deterministic) implements. */
export interface AiSubjectiveEvaluator {
  /** Evaluate one subjective category from observed inputs. */
  evaluate(category: SubjectiveCategory, inputs: SubjectiveInputs): SubjectiveEvaluation;
  /** Human-readable name of this evaluator. */
  readonly name: string;
}

/**
 * DETERMINISTIC FALLBACK — derives each subjective category from objective
 * signals with a fixed, documented mapping. Same inputs → same outputs, always.
 * Evidence strings quote the actual signals observed.
 *
 * Mapping (score per category; all signals from the observed crawl, never
 * invented):
 *   clarity           base 40; +30 has_company_info; +15 has_cta; +15 has_nap
 *   copy_quality      base 30; +min(40, contentLength/250); +15 has_reviews_mention;
 *                     +10 has_company_info
 *   visual_quality    base 30; +25 has_gallery; +20 has_cta; +15 has_viewport-ish
 *                     (represented by has_company_info presence proxy)
 *   trust_presentation base 35; +30 has_reviews_mention; +20 has_nap; +15 has_company_info
 *   conversion_quality base 30; +30 has_cta; +20 has_contact_route-evidence (has_nap proxy);
 *                     +20 contentLength >= 300
 */
export class DeterministicFallbackEvaluator implements AiSubjectiveEvaluator {
  readonly name = 'deterministic-fallback';

  evaluate(category: SubjectiveCategory, inputs: SubjectiveInputs): SubjectiveEvaluation {
    const evidence = [
      `company info present: ${inputs.hasCompanyInfo}`,
      `reviews mentioned: ${inputs.hasReviewsMention}`,
      `home page ~${inputs.contentLength} words`,
      `cta present: ${inputs.hasCta}`,
      `nap present: ${inputs.hasNap}`,
      `gallery present: ${inputs.hasGallery}`,
    ];
    if (inputs.url) evidence.push(`source: ${inputs.url}`);
    const score = clamp(round(this.categoryScore(category, inputs)), 0, 100);
    return {
      category,
      score,
      evidence,
      model: this.name,
      promptRef: 'deterministic-fallback:v1',
    };
  }

  /** The documented mapping (pure, testable). */
  categoryScore(category: SubjectiveCategory, inputs: SubjectiveInputs): number {
    switch (category) {
      case 'clarity':
        return 40 + (inputs.hasCompanyInfo ? 30 : 0) + (inputs.hasCta ? 15 : 0) + (inputs.hasNap ? 15 : 0);
      case 'copy_quality':
        return (
          30 +
          Math.min(40, Math.floor(inputs.contentLength / 250)) +
          (inputs.hasReviewsMention ? 15 : 0) +
          (inputs.hasCompanyInfo ? 10 : 0)
        );
      case 'visual_quality':
        return 30 + (inputs.hasGallery ? 25 : 0) + (inputs.hasCta ? 20 : 0) + (inputs.hasCompanyInfo ? 15 : 0);
      case 'trust_presentation':
        return 35 + (inputs.hasReviewsMention ? 30 : 0) + (inputs.hasNap ? 20 : 0) + (inputs.hasCompanyInfo ? 15 : 0);
      case 'conversion_quality':
        return (
          30 +
          (inputs.hasCta ? 30 : 0) +
          (inputs.hasNap ? 20 : 0) +
          (inputs.contentLength >= 300 ? 20 : 0)
        );
    }
  }
}

/** The default evaluator used until a real AI evaluator is configured. */
export const DEFAULT_EVALUATOR = new DeterministicFallbackEvaluator();

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}