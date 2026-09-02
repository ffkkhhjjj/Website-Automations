/**
 * Lead lifecycle types — the state machine's vocabulary.
 *
 * The state/reason unions are derived from the schema (businesses.lifecycle_state,
 * rejections.reason) so the code can never drift from the database enums.
 */
import type { businesses, rejections } from '../db/schema';
import type { AuditActorType } from '../auth/audit';

/** One of the 22 lead_lifecycle_state enum values. */
export type LeadState = typeof businesses.$inferSelect.lifecycle_state;

/** One of the 10 rejection_reason enum values. */
export type RejectionReason = typeof rejections.$inferSelect.reason;

/** One of the business_operational_status enum values. */
export type BusinessOperationalStatus = typeof businesses.$inferSelect.business_status;

/** Who performed an action. Defaults to SYSTEM when omitted. */
export interface Actor {
  type: AuditActorType;
  id?: string | null;
}

export type LeadLifecycleErrorCode =
  | 'BUSINESS_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'ALREADY_IN_STATE'
  | 'NO_REASONS';

/** Base error for the lifecycle module — always carries a machine-readable code. */
export class LeadLifecycleError extends Error {
  readonly code: LeadLifecycleErrorCode;

  constructor(code: LeadLifecycleErrorCode, message: string) {
    super(message);
    this.name = 'LeadLifecycleError';
    this.code = code;
  }
}

/** Thrown when a transition is not in the legal map — never silently allowed. */
export class InvalidTransitionError extends LeadLifecycleError {
  readonly fromState: LeadState;
  readonly toState: LeadState;
  readonly legalTargets: readonly LeadState[];

  constructor(fromState: LeadState, toState: LeadState, legalTargets: readonly LeadState[]) {
    super(
      'INVALID_TRANSITION',
      `Illegal lead transition ${fromState} → ${toState}; legal targets from ${fromState}: ${legalTargets.join(', ') || '(none — terminal state)'}`,
    );
    this.name = 'InvalidTransitionError';
    this.fromState = fromState;
    this.toState = toState;
    this.legalTargets = legalTargets;
  }
}