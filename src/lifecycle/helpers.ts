/**
 * Small typed state helpers — read-side predicates over lead lifecycle states.
 * Deterministic; no DB access (except getCurrentState).
 */
import { db } from '../db/client.js';
import { businesses } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { LeadState } from './types.js';

/** All 22 valid lifecycle states, in schema order. */
export const VALID_STATES: readonly LeadState[] = [
  'DISCOVERED',
  'ENRICHING',
  'ENRICHED',
  'ANALYZING',
  'ANALYZED',
  'QUALIFIED',
  'REJECTED',
  'DEMO_GENERATING',
  'DEMO_READY',
  'OUTREACH_PENDING',
  'CONTACTED',
  'FOLLOWUP_1',
  'FOLLOWUP_2',
  'RESPONDED',
  'NURTURE',
  'INTERESTED',
  'HOT',
  'SALES_HANDOFF',
  'WON',
  'LOST',
  'DO_NOT_CONTACT',
  'CUSTOMER',
];

export const ALL_STATES_SET: ReadonlySet<string> = new Set(VALID_STATES);

/** A state is a valid member of the lead_lifecycle_state enum. */
export function isValidState(state: string): state is LeadState {
  return ALL_STATES_SET.has(state);
}

/** Leads we can still send outreach/follow-ups to. */
export function isActiveForOutreach(state: LeadState): boolean {
  switch (state) {
    case 'CONTACTED':
    case 'FOLLOWUP_1':
    case 'FOLLOWUP_2':
    case 'RESPONDED':
    case 'NURTURE':
    case 'INTERESTED':
    case 'HOT':
    case 'OUTREACH_PENDING':
      return true;
    default:
      return false;
  }
}

/** A demo exists / can be shown when the lead reached DEMO_READY or beyond. */
export function canShowDemo(state: LeadState): boolean {
  switch (state) {
    case 'DEMO_READY':
    case 'OUTREACH_PENDING':
    case 'CONTACTED':
    case 'FOLLOWUP_1':
    case 'FOLLOWUP_2':
    case 'RESPONDED':
    case 'NURTURE':
    case 'INTERESTED':
    case 'HOT':
    case 'SALES_HANDOFF':
      return true;
    default:
      return false;
  }
}

/** A lead is currently in (or approaching) the sales motion. */
export function isSalesState(state: LeadState): boolean {
  switch (state) {
    case 'SALES_HANDOFF':
    case 'INTERESTED':
    case 'HOT':
    case 'WON':
    case 'CUSTOMER':
      return true;
    default:
      return false;
  }
}

/** A lead is at/after DEMO_GENERATING (the demo pipeline has started). */
export function hasEnteredDemoPipeline(state: LeadState): boolean {
  return DEMO_AND_LATER.has(state);
}

/** Read-only: load the current lifecycle state for a business. */
export async function getCurrentState(businessId: string): Promise<LeadState | null> {
  const rows = await db
    .select({ lifecycle_state: businesses.lifecycle_state })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return rows[0]?.lifecycle_state ?? null;
}

const DEMO_AND_LATER: ReadonlySet<LeadState> = new Set([
  'DEMO_GENERATING',
  'DEMO_READY',
  'OUTREACH_PENDING',
  'CONTACTED',
  'FOLLOWUP_1',
  'FOLLOWUP_2',
  'RESPONDED',
  'NURTURE',
  'INTERESTED',
  'HOT',
  'SALES_HANDOFF',
  'WON',
  'LOST',
  'DO_NOT_CONTACT',
  'CUSTOMER',
  'REJECTED',
]);