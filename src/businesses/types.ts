/**
 * Businesses payload types.
 *
 * Every field comes from real tables (businesses + lead_scores + websites +
 * website_analyses + demos + rejections + lead_state_history + audit_logs).
 * Nothing is fabricated: absent data is null, never a guess.
 */

import type { LeadState, RejectionReason } from '../lifecycle/types.js';

/** One row in the leads table (list view — deliberately lean). */
export interface BusinessListItem {
  id: string;
  businessName: string;
  industry: string;
  city: string | null;
  state: string | null;
  phone: string | null;
  websiteUrl: string | null;
  lifecycleState: LeadState;
  rating: number | null;
  reviewCount: number | null;
  source: string;
  createdAt: string;
}

export interface BusinessListResponse {
  businesses: BusinessListItem[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** Latest score snapshot for a business (append-only lead_scores history). */
export interface BusinessScoreSnapshot {
  websiteQualityScore: number | null;
  businessOpportunityScore: number | null;
  marketFitScore: number | null;
  leadPriorityScore: number | null;
  classification: string | null;
  createdAt: string;
}

/** Latest demo row for a business (detail view keeps the newest few). */
export interface BusinessDemoSummary {
  id: string;
  status: string;
  demoUrl: string | null;
  version: number | null;
  createdAt: string;
}

/** Rejection event recorded for a business. */
export interface BusinessRejectionSummary {
  reason: RejectionReason;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** One lifecycle history row (newest first in the detail payload). */
export interface BusinessHistoryEntry {
  fromState: LeadState | null;
  toState: LeadState;
  note: string | null;
  createdAt: string;
}

/** One audit row touching this business (newest first in the detail payload). */
export interface BusinessAuditEntry {
  action: string;
  actorType: string;
  createdAt: string;
}

/** Full detail payload for GET /api/businesses/:id. */
export interface BusinessDetailResponse {
  id: string;
  businessName: string;
  industry: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  websiteUrl: string | null;
  source: string;
  sourceUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string | null;
  decisionMakerName: string | null;
  decisionMakerRole: string | null;
  contactabilityScore: number | null;
  lifecycleState: LeadState;
  /** Legal next states from the current state (transition map, read live). */
  legalTransitions: LeadState[];
  latestScore: BusinessScoreSnapshot | null;
  websiteAnalyses: {
    url: string;
    status: string;
    score: number | null;
    classification: string;
    analyzedAt: string | null;
  }[];
  demos: BusinessDemoSummary[];
  rejections: BusinessRejectionSummary[];
  history: BusinessHistoryEntry[];
  recentAudit: BusinessAuditEntry[];
  createdAt: string;
  updatedAt: string;
}
