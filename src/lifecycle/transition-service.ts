/**
 * TRANSITION SERVICE — the only way to move a lead between lifecycle states.
 *
 * `transition(businessId, toState, opts)`:
 *  1. loads the business row;
 *  2. validates the proposed move against the strict transition map;
 *  3. writes businesses.lifecycle_state, a lead_state_history row, and an
 *     audit_logs entry (action LEAD_STATE_CHANGED, entity_type business,
 *     actor from the auth context or SYSTEM) — all in ONE DB transaction.
 *
 * If any step fails (including legality checks), the transaction rolls back and
 * nothing is written: a business can never jump states silently, and an audit
 * trail is never missing a transition.
 */
import { db } from '../db/client.js';
import { businesses, leadStateHistory, auditLogs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { canTransition, legalTargets } from './transitions.js';
import {
  LeadLifecycleError,
  InvalidTransitionError,
  type Actor,
  type LeadState,
} from './types.js';

export interface TransitionOptions {
  /** Human-readable note stored on the lead_state_history row. */
  reason?: string | null;
  /** Who performed the transition. Defaults to a SYSTEM actor. */
  actor?: Actor | null;
}

const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: null };

/** Assert helper for the typed record lookup (noUncheckedIndexedAccess). */
function assertArray(value: readonly LeadState[] | undefined, from: LeadState): readonly LeadState[] {
  if (!value) {
    throw new LeadLifecycleError(
      'INVALID_TRANSITION',
      `Lead state ${from} has no transition map entry — cannot transition from it`,
    );
  }
  return value;
}

/**
 * Move a business to `toState`, writing state + history + audit in one
 * transaction. Returns the new state (i.e. `toState`).
 *
 * Throws:
 *  - LeadLifecycleError('BUSINESS_NOT_FOUND') — no such business
 *  - InvalidTransitionError — the move is not in the legal map
 *  - LeadLifecycleError('ALREADY_IN_STATE') — no-op transition rejected
 */
export async function transition(
  businessId: string,
  toState: LeadState,
  opts: TransitionOptions = {},
): Promise<LeadState> {
  const actor = opts.actor ?? SYSTEM_ACTOR;

  return db.transaction(async (tx) => {
    const [business] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);

    if (!business) {
      throw new LeadLifecycleError('BUSINESS_NOT_FOUND', `Business ${businessId} not found`);
    }

    const fromState = business.lifecycle_state;

    if (toState === fromState) {
      throw new LeadLifecycleError(
        'ALREADY_IN_STATE',
        `Business ${businessId} is already in state ${fromState}`,
      );
    }

    const targets = assertArray(legalTargets(fromState), fromState);
    if (!canTransition(fromState, toState)) {
      throw new InvalidTransitionError(fromState, toState, targets);
    }

    await tx
      .update(businesses)
      .set({ lifecycle_state: toState })
      .where(eq(businesses.id, businessId));

    await tx.insert(leadStateHistory).values({
      business_id: businessId,
      from_state: fromState,
      to_state: toState,
      note: opts.reason ?? null,
    });

    await tx.insert(auditLogs).values({
      actor_type: actor.type,
      actor_id: actor.id ?? null,
      action: 'LEAD_STATE_CHANGED',
      entity_type: 'business',
      entity_id: businessId,
      before: { lifecycle_state: fromState },
      after: { lifecycle_state: toState },
      source: 'lifecycle',
      metadata: opts.reason ? { reason: opts.reason } : null,
    });

    return toState;
  });
}