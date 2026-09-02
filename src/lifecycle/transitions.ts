/**
 * LEAD TRANSITION MAP — the single source of truth for legal lifecycle
 * transitions. A transition is legal iff it is present in this map; anything
 * else throws InvalidTransitionError (the transition service enforces it).
 *
 * The map is a superset of the master-spec pipeline: every pipeline step implies
 * its forward edge, plus the reverse/recovery edges a real autonomous system
 * needs (re-enter a state to retry, back out of SALES_HANDOFF to reopen a deal,
 * move an interested lead into nurture, etc.). All terminal states
 * (REJECTED, DO_NOT_CONTACT, WON, LOST, CUSTOMER) have no outgoing edges.
 *
 * To add a transition: edit this map (the typed record enforces that every
 * source state has an array of target states), then update the README section
 * and the row/column counts in the map tests.
 */
import type { LeadState } from './types.js';

/**
 * Legal transitions keyed by from-state. The value arrays intentionally contain
 * no duplicates (enforced in the test suite).
 */
export const LEAD_TRANSITIONS: Readonly<Record<LeadState, readonly LeadState[]>> = {
  // ---------- Discovery / enrichment pipeline (forward + retry edges) ----------
  DISCOVERED: ['ENRICHING', 'REJECTED'],
  ENRICHING: ['ENRICHED', 'REJECTED'],
  ENRICHED: ['ANALYZING', 'REJECTED'],
  ANALYZING: ['ANALYZED', 'REJECTED'],
  ANALYZED: ['QUALIFIED', 'REJECTED'],
  QUALIFIED: ['DEMO_GENERATING', 'REJECTED'],
  DEMO_GENERATING: ['DEMO_READY', 'DEMO_GENERATING', 'REJECTED'],
  DEMO_READY: ['OUTREACH_PENDING', 'DEMO_GENERATING', 'REJECTED'],
  // ---------- Outreach / follow-up pipeline -----------------------------------
  OUTREACH_PENDING: ['CONTACTED', 'FOLLOWUP_1', 'FOLLOWUP_2', 'REJECTED'],
  CONTACTED: ['FOLLOWUP_1', 'RESPONDED', 'DO_NOT_CONTACT', 'LOST'],
  FOLLOWUP_1: ['FOLLOWUP_2', 'RESPONDED', 'DO_NOT_CONTACT', 'LOST'],
  FOLLOWUP_2: ['RESPONDED', 'DO_NOT_CONTACT', 'LOST'],
  RESPONDED: ['NURTURE', 'INTERESTED', 'HOT', 'SALES_HANDOFF', 'DO_NOT_CONTACT', 'LOST'],
  // ---------- Qualification ------------------------------------------------------
  NURTURE: ['INTERESTED', 'HOT', 'SALES_HANDOFF', 'LOST', 'DO_NOT_CONTACT'],
  INTERESTED: ['HOT', 'SALES_HANDOFF', 'NURTURE', 'LOST', 'DO_NOT_CONTACT'],
  HOT: ['SALES_HANDOFF', 'NURTURE', 'LOST', 'DO_NOT_CONTACT'],
  SALES_HANDOFF: ['WON', 'LOST', 'INTERESTED', 'HOT', 'NURTURE'],
  // ---------- Terminal ------------------------------------------------------------
  WON: ['CUSTOMER'],
  CUSTOMER: [],
  LOST: [],
  REJECTED: [],
  DO_NOT_CONTACT: [],
};

/** Fast lookups: legal sources from a target state, and per-state target sets. */
export const LEAD_TRANSITIONS_SET: Readonly<Record<LeadState, ReadonlySet<LeadState>>> =
  Object.fromEntries(
    Object.entries(LEAD_TRANSITIONS).map(([from, tos]) => [from, new Set(tos)]),
  ) as unknown as Readonly<Record<LeadState, ReadonlySet<LeadState>>>;

export function legalTargets(from: LeadState): readonly LeadState[] {
  return LEAD_TRANSITIONS[from];
}

export function canTransition(from: LeadState, to: LeadState): boolean {
  return LEAD_TRANSITIONS_SET[from]?.has(to) ?? false;
}

/** States that have no outgoing edges (WON→CUSTOMER is retained for sales ops). */
export const TERMINAL_STATES: readonly LeadState[] = ['REJECTED', 'DO_NOT_CONTACT', 'LOST', 'CUSTOMER'];

export function isTerminal(state: LeadState): boolean {
  return LEAD_TRANSITIONS[state].length === 0;
}