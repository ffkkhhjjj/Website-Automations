/**
 * Unit tests locking down the transition map itself: completeness, no
 * duplicates, terminal states, and the pipeline the spec requires.
 */
import { describe, it, expect } from 'vitest';
import {
  LEAD_TRANSITIONS,
  LEAD_TRANSITIONS_SET,
  canTransition,
  legalTargets,
  isTerminal,
  TERMINAL_STATES,
} from '../src/lifecycle/transitions';
import { VALID_STATES, isValidState, isActiveForOutreach, canShowDemo } from '../src/lifecycle/helpers';

describe('transition map', () => {
  it('covers every valid lifecycle state as a source', () => {
    for (const state of VALID_STATES) {
      expect(LEAD_TRANSITIONS[state], `missing map entry for ${state}`).toBeDefined();
    }
  });

  it('targets are unique per source (no duplicate edges)', () => {
    for (const [from, targets] of Object.entries(LEAD_TRANSITIONS)) {
      const set = new Set(targets);
      expect(set.size, `duplicates from ${from}`).toBe(targets.length);
    }
  });

  it('every declared edge is legal via canTransition', () => {
    for (const [from, targets] of Object.entries(LEAD_TRANSITIONS)) {
      for (const to of targets) {
        expect(canTransition(from as never, to as never)).toBe(true);
      }
    }
  });

  it('exactly the terminal states have no outgoing edges', () => {
    const terminalFromMap = (Object.keys(LEAD_TRANSITIONS) as (keyof typeof LEAD_TRANSITIONS)[]).filter(
      (s) => LEAD_TRANSITIONS[s].length === 0,
    );
    expect([...terminalFromMap].sort()).toEqual([...TERMINAL_STATES].sort());
    for (const s of TERMINAL_STATES) expect(isTerminal(s)).toBe(true);
    expect(isTerminal('DISCOVERED')).toBe(false);
  });

  it('the required master-spec forward pipeline is present', () => {
    const pipeline = [
      'DISCOVERED', 'ENRICHING', 'ENRICHED', 'ANALYZING', 'ANALYZED', 'QUALIFIED',
      'DEMO_GENERATING', 'DEMO_READY', 'OUTREACH_PENDING', 'CONTACTED', 'FOLLOWUP_1',
      'FOLLOWUP_2', 'RESPONDED',
    ];
    for (let i = 0; i < pipeline.length - 1; i++) {
      expect(canTransition(pipeline[i] as never, pipeline[i + 1] as never)).toBe(true);
    }
    // RESPONDED → the three qualification targets per spec
    for (const target of ['NURTURE', 'INTERESTED', 'HOT'] as const) {
      expect(canTransition('RESPONDED', target)).toBe(true);
    }
    expect(canTransition('SALES_HANDOFF', 'WON')).toBe(true);
    expect(canTransition('SALES_HANDOFF', 'LOST')).toBe(true);
    expect(canTransition('WON', 'CUSTOMER')).toBe(true);
  });

  it('REJECTED / DO_NOT_CONTACT / LOST / CUSTOMER are terminal (no outgoing)', () => {
    for (const s of ['REJECTED', 'DO_NOT_CONTACT', 'LOST', 'CUSTOMER'] as const) {
      expect(LEAD_TRANSITIONS[s]).toHaveLength(0);
      expect(canTransition(s, 'DISCOVERED')).toBe(false);
    }
  });
});

describe('helpers', () => {
  it('isValidState accepts only the 22 enum members', () => {
    expect(VALID_STATES).toHaveLength(22);
    expect(isValidState('ENRICHED')).toBe(true);
    expect(isValidState('enriched')).toBe(false);
    expect(isValidState('NOT_A_STATE')).toBe(false);
  });

  it('LEAD_TRANSITIONS_SET matches LEAD_TRANSITIONS', () => {
    expect(LEAD_TRANSITIONS_SET['DISCOVERED']!.has('ENRICHING')).toBe(true);
    expect(LEAD_TRANSITIONS_SET['REJECTED']!.size).toBe(0);
  });

  it('isActiveForOutreach only admits outreach-eligible states', () => {
    for (const s of ['CONTACTED', 'FOLLOWUP_1', 'FOLLOWUP_2', 'RESPONDED', 'NURTURE', 'INTERESTED', 'HOT', 'OUTREACH_PENDING']) {
      expect(isActiveForOutreach(s)).toBe(true);
    }
    for (const s of ['DISCOVERED', 'ENRICHING', 'ANALYZED', 'QUALIFIED', 'DEMO_READY', 'REJECTED']) {
      expect(isActiveForOutreach(s)).toBe(false);
    }
  });

  it('canShowDemo is true from DEMO_READY through SALES_HANDOFF', () => {
    for (const s of ['DEMO_READY', 'OUTREACH_PENDING', 'CONTACTED', 'RESPONDED', 'SALES_HANDOFF']) {
      expect(canShowDemo(s)).toBe(true);
    }
    for (const s of ['DISCOVERED', 'ENRICHED', 'QUALIFIED', 'DEMO_GENERATING', 'REJECTED']) {
      expect(canShowDemo(s)).toBe(false);
    }
  });
});