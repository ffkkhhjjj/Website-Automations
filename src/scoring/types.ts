/**
 * Scoring engine types + errors.
 *
 * Derives vocabulary from the merged schema (websiteAnalyses/leadScores/
 * businesses/scoringVersions) so code can never drift from the DB enums.
 */
import type {
  websiteAnalyses,
  leadScores,
  businesses,
  scoringVersions,
} from '../db/schema';

/** Website classification enum from website_analyses.classification. */
export type WebsiteClassification = NonNullable<typeof websiteAnalyses.$inferSelect.classification>;

/** Lead classification enum from lead_scores.classification. */
export type LeadClassification = NonNullable<typeof leadScores.$inferSelect.classification>;

/** Business operational status enum from businesses.business_status. */
export type BusinessOperationalStatus = typeof businesses.$inferSelect.business_status;

/** Score type enum from scoring_versions.score_type. */
export type ScoringType = typeof scoringVersions.$inferSelect.score_type;

/** A scoring_versions row (weights snapshot + version identity). */
export type ScoringVersion = typeof scoringVersions.$inferSelect;

/** A single category verdict with its evidence trail (shared by the WSQ and
 *  BOS engines so the two CategoryVerdict interfaces can never drift apart). */
export interface CategoryVerdict {
  category: string;
  score: number;
  evidence: string[];
}

export type ScoringErrorCode =
  | 'BUSINESS_NOT_FOUND'
  | 'WEBSITE_NOT_FOUND'
  | 'INVALID_WEIGHTS'
  | 'INVALID_INPUT'
  | 'EVALUATOR_NOT_CONFIGURED';

/** Base error for the scoring module — always carries a machine-readable code. */
export class ScoringError extends Error {
  readonly code: ScoringErrorCode;

  constructor(code: ScoringErrorCode, message: string) {
    super(message);
    this.name = 'ScoringError';
    this.code = code;
  }
}