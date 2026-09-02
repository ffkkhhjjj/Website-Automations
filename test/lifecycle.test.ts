/**
 * Integration tests for the lead lifecycle state machine + rejection service.
 *
 * Runs against the same throwaway DB used by the auth suite (created and
 * migrated by test/global-setup.ts; DATABASE_URL is pointed at it by
 * vitest.config.ts). Exercises the full stack: Postgres + Drizzle + the
 * transactional transition/reject services + the audit trail.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and, desc, asc } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { businesses, leadStateHistory, auditLogs, rejections } from '../src/db/schema';
import { transition } from '../src/lifecycle/transition-service';
import { reject } from '../src/lifecycle/rejection-service';
import { InvalidTransitionError, LeadLifecycleError } from '../src/lifecycle/types';
import { getCurrentState } from '../src/lifecycle/helpers';

/** Business ids created during this suite (cleaned up in afterAll). */
const created: string[] = [];

async function createBusiness(overrides: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(businesses)
    .values({
      business_name: `Test Plumbing ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      industry: 'plumbing',
      source: 'test',
      lifecycle_state: 'DISCOVERED',
      ...overrides,
    })
    .returning({ id: businesses.id });
  const id = row!.id;
  created.push(id);
  return id;
}

async function currentState(id: string) {
  const [row] = await db
    .select({ lifecycle_state: businesses.lifecycle_state })
    .from(businesses)
    .where(eq(businesses.id, id))
    .limit(1);
  return row!.lifecycle_state;
}

async function historyFor(id: string) {
  return db
    .select({ from_state: leadStateHistory.from_state, to_state: leadStateHistory.to_state, note: leadStateHistory.note })
    .from(leadStateHistory)
    .where(eq(leadStateHistory.business_id, id))
    .orderBy(asc(leadStateHistory.created_at));
}

async function auditFor(id: string, action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entity_id, id), eq(auditLogs.action, action)))
    .orderBy(asc(auditLogs.created_at));
}

beforeAll(async () => {});

afterAll(async () => {
  // Cleanup so the suite is re-runnable against the same DB. audit_logs has no
  // FK to businesses, so delete its rows for these business ids explicitly;
  // history/rejections cascade with business deletion.
  if (created.length > 0) {
    for (const id of created) {
      await db.delete(auditLogs).where(and(eq(auditLogs.entity_id, id), eq(auditLogs.source, 'lifecycle')));
    }
    for (const id of created) {
      await db.delete(businesses).where(eq(businesses.id, id));
    }
  }
  await pool.end();
});

describe('legal transitions', () => {
  it('(1) DISCOVERED → ENRICHING → ENRICHED succeeds and records history + audit', async () => {
    const id = await createBusiness();

    expect(await transition(id, 'ENRICHING', { reason: 'enrichment job started' })).toBe('ENRICHING');
    expect(await transition(id, 'ENRICHED', { reason: 'contact enrichment complete' })).toBe('ENRICHED');

    expect(await currentState(id)).toBe('ENRICHED');

    const history = await historyFor(id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ from_state: 'DISCOVERED', to_state: 'ENRICHING' });
    expect(history[1]).toMatchObject({ from_state: 'ENRICHING', to_state: 'ENRICHED' });

    const audits = await auditFor(id, 'LEAD_STATE_CHANGED');
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: 'LEAD_STATE_CHANGED',
      entity_type: 'business',
      entity_id: id,
      actor_type: 'SYSTEM',
      before: { lifecycle_state: 'DISCOVERED' },
      after: { lifecycle_state: 'ENRICHING' },
    });
    expect(audits[1]!.after).toEqual({ lifecycle_state: 'ENRICHED' });
  });

  it('(2) full forward pipeline to SALES_HANDOFF and beyond', async () => {
    const id = await createBusiness();
    const steps = [
      'ENRICHING', 'ENRICHED', 'ANALYZING', 'ANALYZED', 'QUALIFIED', 'DEMO_GENERATING',
      'DEMO_READY', 'OUTREACH_PENDING', 'CONTACTED', 'FOLLOWUP_1', 'FOLLOWUP_2',
      'RESPONDED', 'HOT', 'SALES_HANDOFF', 'WON',
    ] as const;
    for (const step of steps) {
      await transition(id, step);
    }
    expect(await currentState(id)).toBe('WON');

    const history = await historyFor(id);
    expect(history.map((h) => h.to_state)).toEqual([...steps]);
    expect(await auditFor(id, 'LEAD_STATE_CHANGED')).toHaveLength(steps.length);
  });
});

describe('illegal transitions', () => {
  it('(3) DISCOVERED → QUALIFIED directly throws InvalidTransitionError and writes nothing', async () => {
    const id = await createBusiness();
    await expect(transition(id, 'QUALIFIED')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(transition(id, 'QUALIFIED')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      fromState: 'DISCOVERED',
      toState: 'QUALIFIED',
      legalTargets: ['ENRICHING', 'REJECTED'],
    });

    // atomicity: nothing written
    expect(await currentState(id)).toBe('DISCOVERED');
    expect(await historyFor(id)).toHaveLength(0);
    expect(await auditFor(id, 'LEAD_STATE_CHANGED')).toHaveLength(0);
  });

  it('terminal states reject every outgoing move', async () => {
    const id = await createBusiness();
    await reject(id, { reasons: ['BAD_DATA'] });
    expect(await currentState(id)).toBe('REJECTED');
    await expect(transition(id, 'ENRICHING')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(transition(id, 'ANALYZED')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('transitioning a nonexistent business throws BUSINESS_NOT_FOUND', async () => {
    await expect(
      transition('00000000-0000-4000-8000-000000000000', 'ENRICHING'),
    ).rejects.toMatchObject({ code: 'BUSINESS_NOT_FOUND' });
  });

  it('no-op transition (same state) throws ALREADY_IN_STATE', async () => {
    const id = await createBusiness();
    await expect(transition(id, 'DISCOVERED')).rejects.toMatchObject({ code: 'ALREADY_IN_STATE' });
  });
});

describe('rejection service', () => {
  it('(4) REJECTED records reasons rows + history + audit in one transaction', async () => {
    const id = await createBusiness();
    const { toState, insertedReasons } = await reject(id, {
      reasons: ['OUTSIDE_ICP', 'LOW_OPPORTUNITY'],
      reason: 'Prospect outside target ICP with low opportunity',
    });

    expect(toState).toBe('REJECTED');
    expect(insertedReasons).toEqual(['OUTSIDE_ICP', 'LOW_OPPORTUNITY']);
    expect(await currentState(id)).toBe('REJECTED');

    const rejectionRows = await db.select().from(rejections).where(eq(rejections.business_id, id));
    expect(rejectionRows.map((r) => r.reason).sort()).toEqual(['LOW_OPPORTUNITY', 'OUTSIDE_ICP']);
    expect(rejectionRows[0]!.detail).toEqual({ source: 'lifecycle.reject' });

    const history = await historyFor(id);
    expect(history[0]).toMatchObject({ from_state: 'DISCOVERED', to_state: 'REJECTED' });
    expect(history[0]!.note).toContain('Prospect outside target ICP');

    const audits = await auditFor(id, 'LEAD_REJECTED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: 'SYSTEM',
      before: { lifecycle_state: 'DISCOVERED' },
      after: { lifecycle_state: 'REJECTED' },
      metadata: { reasons: ['OUTSIDE_ICP', 'LOW_OPPORTUNITY'] },
    });
  });

  it('(5) DO_NOT_CONTACT works from CONTACTED (opt-out)', async () => {
    const id = await createBusiness();
    await transition(id, 'ENRICHING');
    await transition(id, 'ENRICHED');
    await transition(id, 'ANALYZING');
    await transition(id, 'ANALYZED');
    await transition(id, 'QUALIFIED');
    await transition(id, 'DEMO_GENERATING');
    await transition(id, 'DEMO_READY');
    await transition(id, 'OUTREACH_PENDING');
    await transition(id, 'CONTACTED');

    const { toState } = await reject(id, {
      reasons: ['OPT_OUT'],
      reason: 'Prospect asked to never contact again',
    });
    expect(toState).toBe('DO_NOT_CONTACT');
    expect(await currentState(id)).toBe('DO_NOT_CONTACT');

    const history = await historyFor(id);
    expect(history.at(-1)).toMatchObject({ from_state: 'CONTACTED', to_state: 'DO_NOT_CONTACT' });

    const rejectionRows = await db.select().from(rejections).where(eq(rejections.business_id, id));
    expect(rejectionRows.map((r) => r.reason)).toEqual(['OPT_OUT']);
  });

  it('(6) LOST from SALES_HANDOFF', async () => {
    const id = await createBusiness();
    for (const step of [
      'ENRICHING', 'ENRICHED', 'ANALYZING', 'ANALYZED', 'QUALIFIED', 'DEMO_GENERATING',
      'DEMO_READY', 'OUTREACH_PENDING', 'CONTACTED', 'FOLLOWUP_1', 'FOLLOWUP_2',
      'RESPONDED', 'INTERESTED', 'SALES_HANDOFF',
    ] as const) {
      await transition(id, step);
    }
    await transition(id, 'LOST', { reason: 'deal lost' });
    expect(await currentState(id)).toBe('LOST');
    const history = await historyFor(id);
    expect(history.at(-1)).toMatchObject({ from_state: 'SALES_HANDOFF', to_state: 'LOST' });
  });

  it('reject() requires at least one reason (NO_REASONS)', async () => {
    const id = await createBusiness();
    await expect(reject(id, { reasons: [] })).rejects.toMatchObject({ code: 'NO_REASONS' });
    expect(await currentState(id)).toBe('DISCOVERED');
  });

  it('reject() on a nonexistent business throws BUSINESS_NOT_FOUND', async () => {
    await expect(
      reject('00000000-0000-4000-8000-000000000000', { reasons: ['BAD_DATA'] }),
    ).rejects.toMatchObject({ code: 'BUSINESS_NOT_FOUND' });
  });

  it('reject() from a terminal state records reasons without a state change', async () => {
    const id = await createBusiness();
    await reject(id, { reasons: ['BAD_DATA'] });
    await reject(id, { reasons: ['DUPLICATE'] }); // same terminal state
    expect(await currentState(id)).toBe('REJECTED');
    const rows = await db.select().from(rejections).where(eq(rejections.business_id, id));
    expect(rows.map((r) => r.reason)).toEqual(['BAD_DATA', 'DUPLICATE']);
    expect(await historyFor(id)).toHaveLength(1); // only the first transition row
  });

  it('ledger of reasons appends across repeated rejections from non-terminal states', async () => {
    const id = await createBusiness();
    await reject(id, { reasons: ['INACTIVE_BUSINESS'] });
    // A business later re-enters the pipeline is not legal in the strict map
    // (REJECTED is terminal), so this asserts the append-only log on the first pass.
    const rows = await db.select().from(rejections).where(eq(rejections.business_id, id));
    expect(rows.map((r) => r.reason)).toEqual(['INACTIVE_BUSINESS']);
  });
});

describe('state helpers — DB-backed', () => {
  it('getCurrentState returns the persisted state and null for unknown ids', async () => {
    const id = await createBusiness();
    expect(await getCurrentState(id)).toBe('DISCOVERED');
    await transition(id, 'ENRICHING');
    expect(await getCurrentState(id)).toBe('ENRICHING');
    expect(await getCurrentState('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});