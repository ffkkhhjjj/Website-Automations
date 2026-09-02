/**
 * REJECTION SERVICE — records WHY a lead was rejected and moves it to a
 * terminal state (REJECTED or DO_NOT_CONTACT), all atomically.
 *
 * `reject(businessId, { reasons, actor? })`:
 *   - resolves the terminal state: DO_NOT_CONTACT when any reason is an explicit
 *     opt-out / do-not-contact request, otherwise REJECTED;
 *   - runs the same transitional integrity as `transition` (legal-map check,
 *     one transaction, state + history + audit rows);
 *   - additionally inserts one `rejections` row per reason so later analytics
 *     can aggregate rejection causes without parsing history notes.
 *
 * Ordering note: each rejection call appends NEW rejections rows and ADDS a new
 * history row (REJECTED rows are not rewritten) — the same business can be
 * rejected again later with more reasons; `rejections` remains the full log.
 */
import { db } from '../db/client.js';
import { businesses, leadStateHistory, auditLogs, rejections } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { canTransition } from './transitions.js';
import {
  LeadLifecycleError,
  InvalidTransitionError,
  type Actor,
  type LeadState,
  type RejectionReason,
} from './types.js';

/** Reasons that drive the DO_NOT_CONTACT terminal state. */
export const DO_NOT_CONTACT_REASONS: readonly RejectionReason[] = [
  'OPT_OUT',
  'DO_NOT_CONTACT_REQUEST',
];

export interface RejectionInput {
  /** One or more reasons. Must be non-empty (guards silent rejects). */
  reasons: RejectionReason[];
  /** Human-readable summary written on the lead_state_history note. */
  reason?: string | null;
  /** Who rejected the lead. Defaults to SYSTEM. */
  actor?: Actor | null;
}

export interface RejectResult {
  toState: LeadState;
  insertedReasons: RejectionReason[];
}

const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: null };

export function isDoNotContactReason(reason: RejectionReason): boolean {
  return DO_NOT_CONTACT_REASONS.includes(reason);
}

/** Resolve the terminal target state for a reason set. */
export function resolveRejectTarget(reasons: readonly RejectionReason[]): LeadState {
  if (reasons.some(isDoNotContactReason)) {
    return 'DO_NOT_CONTACT';
  }
  return 'REJECTED';
}

/**
 * Reject a business. Records every reason as a `rejections` row, transitions
 * to REJECTED (or DO_NOT_CONTACT), writes history + audit — all in one
 * transaction. Returns the terminal state reached.
 */
export async function reject(
  businessId: string,
  input: RejectionInput,
): Promise<RejectResult> {
  if (input.reasons.length === 0) {
    throw new LeadLifecycleError('NO_REASONS', 'reject() requires at least one reason');
  }

  const actor = input.actor ?? SYSTEM_ACTOR;
  const toState = resolveRejectTarget(input.reasons);

  await db.transaction(async (tx) => {
    const [business] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);

    if (!business) {
      throw new LeadLifecycleError('BUSINESS_NOT_FOUND', `Business ${businessId} not found`);
    }

    const fromState = business.lifecycle_state;

    if (fromState === toState) {
      // Already in the same terminal state — still record the new reasons and
      // an audit entry, but skip a redundant state transition.
      for (const reason of input.reasons) {
        await tx.insert(rejections).values({
          business_id: businessId,
          reason,
          detail: { source: 'lifecycle.reject' },
        });
      }
      await tx.insert(auditLogs).values({
        actor_type: actor.type,
        actor_id: actor.id ?? null,
        action: 'LEAD_REJECTED',
        entity_type: 'business',
        entity_id: businessId,
        before: { lifecycle_state: fromState },
        after: { lifecycle_state: toState }, // unchanged; reasons appended
        source: 'lifecycle',
        metadata: { reasons: input.reasons },
      });
      return;
    }

    if (!canTransition(fromState, toState)) {
      // E.g. trying to reject a WON/CUSTOMER lead, or REJECTED from a terminal
      // state — the map decides, never silent.
      throw new InvalidTransitionError(fromState, toState, []);
    }

    await tx
      .update(businesses)
      .set({ lifecycle_state: toState })
      .where(eq(businesses.id, businessId));

    for (const reason of input.reasons) {
      await tx.insert(rejections).values({
        business_id: businessId,
        reason,
        detail: { source: 'lifecycle.reject' },
      });
    }

    await tx.insert(leadStateHistory).values({
      business_id: businessId,
      from_state: fromState,
      to_state: toState,
      note: input.reason ?? `Rejected: ${input.reasons.join(', ')}`,
    });

    await tx.insert(auditLogs).values({
      actor_type: actor.type,
      actor_id: actor.id ?? null,
      action: 'LEAD_REJECTED',
      entity_type: 'business',
      entity_id: businessId,
      before: { lifecycle_state: fromState },
      after: { lifecycle_state: toState },
      source: 'lifecycle',
      metadata: { reasons: input.reasons },
    });
  });

  return { toState, insertedReasons: input.reasons };
}