/**
 * Orchestrator integration tests — full stack against the throwaway test DB
 * (created + migrated by test/global-setup.ts; vitest points DATABASE_URL at
 * it). beforeAll seeds the same system_settings + scoring_versions v1 rows the
 * dev DB gets from `npm run db:seed`, so the scoring config readers work.
 *
 * Proves the orchestrator persists analyses + ONE lead_scores row per run with
 * formula snapshot + scoring_version FK, keeps history on re-scoring, and NEVER
 * touches the lifecycle state machine.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and, asc } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import {
  businesses,
  websites,
  websiteAnalyses,
  leadScores,
  auditLogs,
  scoringVersions,
  systemSettings,
} from '../src/db/schema';
import { scoreBusiness, getScoreHistory } from '../src/scoring/orchestrator';
import type { WebsiteInput } from '../src/scoring/website-input';

const created: string[] = [];

/** Seed the test DB with the same defaults seed.ts writes (ON CONFLICT safe). */
async function seedDefaults(): Promise<void> {
  const settings = [
    { key: 'target.industries', value: ['plumbing'], type: 'array' },
    { key: 'target.states', value: [], type: 'array' },
    { key: 'scoring.website_quality.weights', value: { conversion: 25, mobile: 20, content: 15, trust: 15, technical: 15, design_ux: 10 }, type: 'json' },
    { key: 'scoring.business_opportunity.weights', value: { viability: 25, demand: 25, ability_to_pay: 20, contactability: 20, icp_fit: 10 }, type: 'json' },
    { key: 'scoring.lead_priority.formula', value: { website_quality: 0.45, business_opportunity: 0.4, market_fit: 0.15 }, type: 'json' },
    { key: 'scoring.lead_classification.thresholds', value: { high_priority_min: 80, secondary_min: 65, review_min: 50 }, type: 'json' },
    { key: 'scoring.rejection.thresholds', value: { min_opportunity_score: 50, excellent_website_min: 90, min_contactability_score: 40, inactive_statuses: ['CLOSED', 'PERMANENTLY_CLOSED', 'TEMPORARILY_CLOSED'] }, type: 'json' },
  ] as const;
  for (const s of settings) {
    await db
      .insert(systemSettings)
      .values({ key: s.key, value: s.value as never, type: s.type, description: 'test seed' })
      .onConflictDoNothing({ target: systemSettings.key });
  }
  const versions = [
    { score_type: 'WEBSITE_QUALITY', version: 1, weights: { conversion: 25, mobile: 20, content: 15, trust: 15, technical: 15, design_ux: 10 } },
    { score_type: 'BUSINESS_OPPORTUNITY', version: 1, weights: { viability: 25, demand: 25, ability_to_pay: 20, contactability: 20, icp_fit: 10 } },
    { score_type: 'LEAD_PRIORITY', version: 1, weights: { website_quality: 0.45, business_opportunity: 0.4, market_fit: 0.15 } },
  ] as const;
  for (const v of versions) {
    await db
      .insert(scoringVersions)
      .values({ score_type: v.score_type as never, version: v.version, weights: v.weights as never, description: 'test v1', is_active: true })
      .onConflictDoNothing({ target: [scoringVersions.score_type, scoringVersions.version] });
  }
}

async function createBusiness(overrides: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(businesses)
    .values({
      business_name: `Score Test Plumbing ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

/** Unique host per test so the global websites.url unique index never collides.
 *  Same host = same website row (used for re-scoring history checks). */
function crawlInput(host = 'scoredplumber'): WebsiteInput {
  return {
    url: `https://${host}.example.com`,
    pages: [
      {
        url: `https://${host}.example.com`,
        httpStatus: 200,
        html: `<html><head>
          <title>Scored Plumber - Emergency Plumbing</title>
          <meta name="description" content="Fast local plumbing. Water heater and drain repair.">
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head><body>
          <h1>Scored Plumber</h1><p>Reviews and testimonials below.</p>
          <img src="a.jpg"><img src="b.jpg">
          <a href="tel:+15125550000">Call us</a>
          <a href="/services">Services</a><a href="/contact">Contact</a>
          <form action="/contact"></form>
        </body></html>`,
        responseTimeMs: 400,
      },
      { url: `https://${host}.example.com/services`, httpStatus: 200, html: '<h1>Services</h1>' },
    ],
    observedBusinessName: 'Scored Plumber',
    observedPhone: '+15125550000',
    observedAddress: '1 Main St, Austin TX',
  };
}

async function audits(businessId: string, action: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entity_id, businessId), eq(auditLogs.action, action)))
    .orderBy(asc(auditLogs.created_at));
}

beforeAll(async () => {
  await seedDefaults();
});

afterAll(async () => {
  // Throwaway DB is dropped on the next run; delete our rows so the suite is
  // re-runnable within a single run.
  await db.delete(auditLogs).where(eq(auditLogs.source, 'scoring'));
  if (created.length > 0) {
    for (const id of created) {
      await db.delete(businesses).where(eq(businesses.id, id));
    }
  }
  await pool.end();
});

describe('scoreBusiness orchestrator', () => {
  it('(1) full run: NO_WEBSITE business → WSQ 0/NO_WEBSITE + lead_scores row + audit, no lifecycle change', async () => {
    const id = await createBusiness({ website_url: null });

    const result = await scoreBusiness(id);
    expect(result.websiteQualityScore).toBe(0);

    // Lead score row persisted with formula snapshot + version FK.
    const [scoreRow] = await db
      .select()
      .from(leadScores)
      .where(eq(leadScores.business_id, id))
      .orderBy(asc(leadScores.created_at));
    expect(scoreRow).toBeDefined();
    expect(scoreRow!.website_quality_score).toBe(0);
    expect(scoreRow!.classification).toBe("REVIEW"); // 54.75 = (100-0)*0.45 + 15*0.4 + 25*0.15 → REVIEW
    expect(scoreRow!.scoring_version).not.toBeNull();
    const fields = scoreRow!.formula_fields as {
      inputs: Record<string, number | null>;
      weights: Record<string, number>;
      formula_version: string;
      thresholds: Record<string, number>;
    };
    expect(fields.inputs.website_quality_score).toBe(0);
    expect(fields.weights.website_quality).toBe(0.45);
    expect(fields.formula_version).toBe('scoring.lead_priority.formula');
    expect(fields.thresholds.high_priority_min).toBe(80);

    // NO_WEBSITE → no website row, no analysis row.
    const webRows = await db.select().from(websites).where(eq(websites.business_id, id));
    expect(webRows).toHaveLength(0);

    // Audit written with source='scoring'.
    const scoredAudits = await audits(id, 'LEAD_SCORED');
    expect(scoredAudits).toHaveLength(1);
    expect(scoredAudits[0]!.metadata).toMatchObject({ website_quality_score: 0, classification: "REVIEW" });

    // Lifecycle state untouched.
    const [row] = await db.select({ s: businesses.lifecycle_state }).from(businesses).where(eq(businesses.id, id));
    expect(row!.s).toBe('DISCOVERED');
  });

  it('(2) website analyzed: analysis row written, website status → ANALYZED, lifecycle untouched', async () => {
    const id = await createBusiness({ website_url: 'https://scoredplumber.example.com' });
    const result = await scoreBusiness(id, { websiteInput: crawlInput() });

    expect(result.websiteQualityScore).toBeGreaterThan(60);
    expect(result.websiteAnalysisId).not.toBeNull();

    const [analysis] = await db
      .select()
      .from(websiteAnalyses)
      .where(eq(websiteAnalyses.id, result.websiteAnalysisId!));
    expect(analysis!.website_quality_score).toBe(result.websiteQualityScore);
    expect(analysis!.classification).toBeDefined();
    expect(analysis!.category_scores).not.toBeNull();
    expect(analysis!.analysis_version).not.toBeNull();
    const tests = analysis!.test_results as { outcomes: { checkId: string; result: string }[] };
    expect(tests.outcomes.find((o) => o.checkId === 'has_https')!.result).toBe('PASS');
    const ev = analysis!.evidence as { weights: Record<string, number>; ai_evaluator: { configured: boolean } };
    expect(ev.weights.conversion).toBe(25);
    expect(ev.ai_evaluator.configured).toBe(false); // honest requires-configuration state

    // Website status → ANALYZED (dataset mutation; NOT a lifecycle state).
    const [site] = await db
      .select({ status: websites.status, id: websites.id })
      .from(websites)
      .where(eq(websites.business_id, id))
      .limit(1);
    expect(site!.status).toBe('ANALYZED');

    // WEBSITE_ANALYZED audit on the website entity + LEAD_SCORED on the business.
    const siteId = site!.id;
    const analyzedAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'WEBSITE_ANALYZED'), eq(auditLogs.entity_id, siteId)));
    expect(analyzedAudit).toHaveLength(1);
    expect(analyzedAudit[0]!.metadata).toMatchObject({ website_quality_score: result.websiteQualityScore });
    expect(await audits(id, 'LEAD_SCORED')).toHaveLength(1);

    // Lifecycle state untouched.
    const [row] = await db.select({ s: businesses.lifecycle_state }).from(businesses).where(eq(businesses.id, id));
    expect(row!.s).toBe('DISCOVERED');
  });

  it('(3) re-scoring keeps history: one row per run, newest first', async () => {
    const id = await createBusiness();
    const first = await scoreBusiness(id, { websiteInput: crawlInput("history1") });
    const second = await scoreBusiness(id, { websiteInput: crawlInput("history1") });

    expect(first.leadScoreId).not.toBe(second.leadScoreId);
    const history = await getScoreHistory(id);
    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe(second.leadScoreId); // newest first
    expect(history[1]!.id).toBe(first.leadScoreId);
    expect(history[0]!.scoring_version).toBe(history[1]!.scoring_version); // both v1

    const scoreRows = await db.select().from(leadScores).where(eq(leadScores.business_id, id));
    expect(scoreRows).toHaveLength(2);
    const [site] = await db.select({ id: websites.id }).from(websites).where(eq(websites.business_id, id)).limit(1);
    const analysisRows = await db.select().from(websiteAnalyses).where(eq(websiteAnalyses.website_id, site!.id));
    expect(analysisRows).toHaveLength(2);
    expect(await audits(id, 'LEAD_SCORED')).toHaveLength(2);
  });

  it('(4) scoring_version FK resolves to an active seeded version', async () => {
    const id = await createBusiness();
    await scoreBusiness(id, { websiteInput: crawlInput("host4") });
    const [scoreRow] = await db
      .select()
      .from(leadScores)
      .where(eq(leadScores.business_id, id))
      .orderBy(asc(leadScores.created_at));
    const [version] = await db
      .select()
      .from(scoringVersions)
      .where(eq(scoringVersions.id, scoreRow!.scoring_version!));
    expect(version!.score_type).toBe('LEAD_PRIORITY');
    expect(version!.is_active).toBe(true);
    expect(version!.weights).toEqual({ website_quality: 0.45, business_opportunity: 0.4, market_fit: 0.15 });
  });

  it('(5) unknown business → typed ScoringError', async () => {
    await expect(
      scoreBusiness('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'BUSINESS_NOT_FOUND' });
  });
});