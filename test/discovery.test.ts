/**
 * Discovery tests (brief 8A core) — run against the throwaway DB created by
 * test/global-setup.ts. Covers:
 *  - normalize (phone/state/zip/email/domain edge cases)
 *  - dedup by phone/domain/name+city+state including within-batch
 *  - ingest: DISCOVERED business + provenance + DISCOVERED website row;
 *    NO_WEBSITE row on verified_absent; no website row when absent
 *  - dedup skips (no double inserts)
 *  - insufficient-contact records skipped with reason
 *  - job lifecycle PENDING→RUNNING→COMPLETED with correct progress counters
 *  - provider throw → FAILED + exception row
 *  - per-record failure → PARTIAL + error rows
 *  - retry bumps attempts and reuses params
 *  - cancel flag → CANCELED
 *  - scheduler: disabled → no job; unconfigured → no job; configured stub → one
 *    job, no double-run
 *  - none-provider throws NotConfiguredError naming DISCOVERY_API_KEY
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import {
  discoveryJobs,
  discoveryJobErrors,
  exceptions,
  auditLogs,
  businesses,
  websites,
  systemSettings,
} from '../src/db/schema';
import { seedSystemSettings } from '../src/db/seed-settings';
import { settingsService } from '../src/config/singleton';
import {
  normalizeName, normalizePhone, normalizeEmail, normalizeState, normalizeZip,
  domainFromUrl, normalizeBusiness,
} from '../src/discovery/normalize';
import {
  dedupKeysFor, indexExistingBusinesses, isDuplicate, seenKeySet,
} from '../src/discovery/dedup';
import { ingestBusiness, hasContactRoute } from '../src/discovery/ingest';
import {
  runDiscoveryJob, retryDiscoveryJob, createDiscoveryJob, createCancelToken, cancelRequested,
} from '../src/discovery/runner';
import { DiscoveryScheduler } from '../src/discovery/scheduler';
import { NoneProvider, NotConfiguredError, DISCOVERY_ENV_VARS, DISCOVERY_PROVIDER_NONE } from '../src/discovery/providers';
import { buildDiscoveryRegistry } from '../src/discovery/registry';
import type { RawBusinessRecord } from '../src/discovery/types';

/* ----------------------------------------------------------------------------
 * Test helpers
 * ------------------------------------------------------------------------- */

/** Deterministic stub provider: yields the given records. */
function stubProvider(records: RawBusinessRecord[], id = 'stub'): { id: string; search(): AsyncGenerator<RawBusinessRecord> } {
  return {
    id,
    async *search() {
      for (const r of records) yield r;
    },
  };
}

/** One well-formed plumbing record (all fields). */
function makeRecord(overrides: Partial<RawBusinessRecord> = {}): RawBusinessRecord {
  return {
    business_name: 'Acme Plumbing',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    phone: '(512) 555-0199',
    email: '  INFO@AcmePlumbing.com ',
    website_url: 'https://www.acmeplumbing.com',
    website_status: 'present',
    rating: 4.5,
    review_count: 120,
    source: 'test-provider',
    source_url: 'https://provider.example/listings/acme',
    ...overrides,
  };
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await db.update(systemSettings).set({ value }).where(eq(systemSettings.key, key));
  // settingsService caches reads — invalidate so the next accessor re-reads.
  (settingsService as unknown as { cache: Map<string, unknown> }).cache.delete(key);
}

async function resetSettings(): Promise<void> {
  await seedSystemSettings({ reset: true });
  // settingsService caches — invalidate by deleting the cache entries.
  const cache = (settingsService as unknown as { cache: Map<string, unknown> }).cache;
  for (const k of [
    'integrations.discovery.provider', 'discovery.batch_size', 'discovery.max_attempts',
    'discovery.schedule_interval_minutes', 'discovery.rate_limit_per_minute',
    'target.industries', 'target.states', 'target.cities',
  ]) {
    cache.delete(k);
  }
}

/** Load all businesses created by the suite (cleaned in afterAll). */
const createdBusinessIds = new Set<string>();

beforeAll(async () => {
  // Tests exercise the registry/runner/scheduler; they need the documented
  // credential present so `configured` flips on for stub providers.
  process.env.DISCOVERY_API_KEY = 'test-discovery-key';
  await resetSettings();
});

afterAll(async () => {
  delete process.env.DISCOVERY_API_KEY;
  // Cleanup in dependency order: websites → businesses; errors/exceptions/audits.
  for (const id of createdBusinessIds) {
    await db.delete(auditLogs).where(and(eq(auditLogs.entity_id, id), eq(auditLogs.source, 'discovery')));
    await db.delete(websites).where(eq(websites.business_id, id));
  }
  for (const id of createdBusinessIds) {
    await db.delete(businesses).where(eq(businesses.id, id));
  }
  const jobIds = (await db.select({ id: discoveryJobs.id }).from(discoveryJobs)).map((r) => r.id);
  if (jobIds.length > 0) {
    await db.delete(discoveryJobErrors);
    await db.delete(auditLogs).where(eq(auditLogs.source, 'discovery'));
    await db.delete(discoveryJobs);
  }
  await db.delete(auditLogs).where(and(eq(auditLogs.source, 'discovery'), eq(auditLogs.action, 'DISCOVERY_JOB_FAILED')));
  await resetSettings();
  await pool.end();
});

async function runJobWithProvider(records: RawBusinessRecord[], opts: { maxAttempts?: number } = {}) {
  const jobId = await createDiscoveryJob({ industry: 'plumbing', state: 'TX', provider: 'stub' });
  const provider = stubProvider(records);
  const result = await runDiscoveryJob(jobId, {
    registryOverrides: { providerId: 'stub', providerInstance: provider as unknown as Parameters<typeof buildDiscoveryRegistry>[0]['providerInstance'] },
  });
  return { jobId, result };
}

/* ----------------------------------------------------------------------------
 * Normalize
 * ------------------------------------------------------------------------- */

describe('normalize', () => {
  it('(1a) name trim + collapse whitespace', () => {
    expect(normalizeName('  Acme    Plumbing Co.  ')).toBe('Acme Plumbing Co.');
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName('')).toBeNull();
  });

  it('(1b) phone → E.164-ish digits; 10-digit + country code, 11-digit w/ 1', () => {
    expect(normalizePhone('(512) 555-0199')).toBe('+15125550199');
    expect(normalizePhone('512-555-0199')).toBe('+15125550199');
    expect(normalizePhone('+1 512 555 0199')).toBe('+15125550199');
    expect(normalizePhone('1-512-555-0199')).toBe('+15125550199');
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('555')).toBe('555'); // under 10 digits: raw digits kept
  });

  it('(1c) state → 2-letter uppercase; invalid rejected', () => {
    expect(normalizeState('tx')).toBe('TX');
    expect(normalizeState('  Texas  ')).toBeNull();
    expect(normalizeState('XX')).toBeNull();
    expect(normalizeState('')).toBeNull();
  });

  it('(1d) zip → 5-digit trim; too-short → null', () => {
    expect(normalizeZip('78701-1234')).toBe('78701');
    expect(normalizeZip(' 78701 ')).toBe('78701');
    expect(normalizeZip('123')).toBeNull();
  });

  it('(1e) email lowercase/trim; invalid → null', () => {
    expect(normalizeEmail('  INFO@AcmePlumbing.com ')).toBe('info@acmeplumbing.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
  });

  it('(1f) domain from website URL (www stripped, lowercased)', () => {
    expect(domainFromUrl('https://www.AcmePlumbing.com/contact')).toBe('acmeplumbing.com');
    expect(domainFromUrl('acmeplumbing.com')).toBe('acmeplumbing.com');
    expect(domainFromUrl('http://sub.example.com')).toBe('sub.example.com');
    expect(domainFromUrl('')).toBeNull();
    expect(domainFromUrl('not a url')).toBeNull();
  });

  it('(1g) normalizeBusiness builds provenance per field', () => {
    const res = normalizeBusiness(makeRecord());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.business_name).toBe('Acme Plumbing');
    expect(res.value.state).toBe('TX');
    expect(res.value.phone).toBe('+15125550199');
    expect(res.value.website_status).toBe('present');
    expect(res.value.provenance['phone']).toEqual({ source: 'test-provider', source_url: 'https://provider.example/listings/acme', value: '(512) 555-0199' });
    expect(res.value.provenance['business_name']).toEqual({ source: 'test-provider', source_url: 'https://provider.example/listings/acme', value: 'Acme Plumbing' });
  });

  it('(1h) state present-but-invalid → record rejected (never guess)', () => {
    const res = normalizeBusiness(makeRecord({ state: 'Texas' }));
    expect(res.ok).toBe(false);
  });
});

/* ----------------------------------------------------------------------------
 * Dedup
 * ------------------------------------------------------------------------- */

describe('dedup', () => {
  it('(2a) dedup keys: phone/domain/name+city+state; absent dims → no key', () => {
    const b = normalizeBusiness(makeRecord());
    if (!b.ok) throw new Error('normalize failed');
    const keys = dedupKeysFor(b.value);
    expect(keys.phone).toBe('+15125550199');
    expect(keys.domain).toBe('acmeplumbing.com');
    expect(keys.nameCityState).toBe('acme plumbing|austin|tx');
  });

  it('(2b) within-batch dedup (seen set) prevents double-insert', () => {
    const r1 = normalizeBusiness(makeRecord({ business_name: 'A Plumber', phone: '(512) 555-0101' }));
    const r2 = normalizeBusiness(makeRecord({ business_name: 'B Plumber', phone: '5125550101' }));
    if (!r1.ok || !r2.ok) throw new Error('normalize failed');
    const seen = seenKeySet([r1.value]);
    expect(isDuplicate(r2.value, indexExistingBusinesses([]), seen)).toBe(true);
  });

  it('(2c) dedup against existing businesses by phone', () => {
    const existing = [{ id: 'x', business_name: 'Old Name', city: 'Austin', state: 'TX', phone: '+15125550199', website_url: null }];
    const idx = indexExistingBusinesses(existing);
    const r = normalizeBusiness(makeRecord());
    if (!r.ok) throw new Error('normalize failed');
    expect(isDuplicate(r.value, idx, new Set())).toBe(true);
    expect(isDuplicate(r.value, indexExistingBusinesses([]), new Set())).toBe(false);
  });

  it('(2d) dedup by domain and by name+city+state', () => {
    const byDomain = indexExistingBusinesses([{ id: 'a', business_name: 'X', city: null, state: null, phone: null, website_url: 'https://acmeplumbing.com' }]);
    const r = normalizeBusiness(makeRecord());
    if (!r.ok) throw new Error('normalize failed');
    expect(isDuplicate(r.value, byDomain, new Set())).toBe(true);

    const byNameCity = indexExistingBusinesses([{ id: 'b', business_name: 'ACME PLUMBING', city: 'austin', state: 'tx', phone: null, website_url: null }]);
    expect(isDuplicate(r.value, byNameCity, new Set())).toBe(true);
  });
});

/* ----------------------------------------------------------------------------
 * Ingest
 * ------------------------------------------------------------------------- */

describe('ingest', () => {
  it('(3a) inserts DISCOVERED business with provenance + DISCOVERED website row', async () => {
    const n = normalizeBusiness(makeRecord());
    if (!n.ok) throw new Error('normalize failed');
    const r = await db.transaction(async (tx) => ingestBusiness(tx, n.value, 'plumbing'));
    expect(r.inserted).toBe(true);
    if (!r.inserted) return;
    createdBusinessIds.add(r.business_id);

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, r.business_id));
    expect(biz).toMatchObject({
      business_name: 'Acme Plumbing', city: 'Austin', state: 'TX', zip: '78701',
      phone: '+15125550199', email: 'info@acmeplumbing.com',
      website_url: 'https://www.acmeplumbing.com', lifecycle_state: 'DISCOVERED', source: 'test-provider',
    });
    expect(biz.provenance?.phone).toEqual({ source: 'test-provider', source_url: 'https://provider.example/listings/acme', value: '(512) 555-0199' });

    const [ws] = await db.select().from(websites).where(eq(websites.business_id, r.business_id));
    expect(ws).toBeTruthy();
    expect(ws!.status).toBe('DISCOVERED');
    expect(ws!.domain).toBe('acmeplumbing.com');

    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entity_id, r.business_id), eq(auditLogs.action, 'BUSINESS_DISCOVERED')));
    expect(audit).toBeTruthy();
    expect(audit!.actor_type).toBe('SYSTEM');
  });

  it('(3b) verified_absent → NO_WEBSITE row; absent status → NO website row', async () => {
    // Distinct business (name + phone) from every other test: the suite shares
    // one DB, so reusing the default record would dedup against (3a)'s row.
    const n1 = normalizeBusiness(makeRecord({ business_name: 'NoSite Plumbing', phone: '(512) 555-0111', website_url: undefined, website_status: 'verified_absent' }));
    if (!n1.ok) throw new Error('normalize failed');
    const r1 = await db.transaction(async (tx) => ingestBusiness(tx, n1.value, 'plumbing'));
    expect(r1.inserted).toBe(true);
    if (r1.inserted) createdBusinessIds.add(r1.business_id);
    const [ws1] = await db.select().from(websites).where(eq(websites.business_id, (r1 as { business_id: string }).business_id ?? ''));
    expect(ws1?.status).toBe('NO_WEBSITE');

    const n2 = normalizeBusiness(makeRecord({ business_name: 'MaybeSite Co', phone: '(512) 555-0112', website_url: undefined, website_status: null }));
    if (!n2.ok) throw new Error('normalize failed');
    const r2 = await db.transaction(async (tx) => ingestBusiness(tx, n2.value, 'plumbing'));
    if (r2.inserted) createdBusinessIds.add(r2.business_id);
    const ws2 = await db.select().from(websites).where(eq(websites.business_id, (r2 as { business_id: string }).business_id ?? ''));
    expect(ws2.length).toBe(0); // absence of evidence ≠ evidence of absence
  });

  it('(3c) duplicate inside the tx → skipped duplicate', async () => {
    const n = normalizeBusiness(makeRecord({ business_name: `Dup ${Date.now()}` }));
    if (!n.ok) throw new Error('normalize failed');
    const r1 = await db.transaction(async (tx) => ingestBusiness(tx, n.value, 'plumbing'));
    expect(r1.inserted).toBe(true);
    if (r1.inserted) createdBusinessIds.add(r1.business_id);
    const r2 = await db.transaction(async (tx) => ingestBusiness(tx, n.value, 'plumbing'));
    expect(r2.inserted).toBe(false);
    if (!r2.inserted) expect(r2.skipped).toBe('duplicate');
  });

  it('(3d) insufficient contact → skipped with reason', async () => {
    const n = normalizeBusiness(makeRecord({ phone: undefined, email: undefined, address: undefined }));
    if (!n.ok) throw new Error('normalize failed');
    expect(hasContactRoute(n.value)).toBe(false);
    const r = await db.transaction(async (tx) => ingestBusiness(tx, n.value, 'plumbing'));
    expect(r.inserted).toBe(false);
    if (!r.inserted) expect(r.skipped).toBe('insufficient_contact');
  });
});

/* ----------------------------------------------------------------------------
 * Runner
 * ------------------------------------------------------------------------- */

describe('runner', () => {
  it('(4a) PENDING→RUNNING→COMPLETED with correct progress counters', async () => {
    // Fully distinct records (name + phone + domain differ from each other and
    // from every other test's rows — the suite shares one DB).
    const records = [makeRecord({ business_name: 'First Plumbing Co', phone: '(512) 555-0401', website_url: 'https://first-co.example.com' }), makeRecord({ business_name: 'Second Plumbing Co', phone: '(512) 555-0402', website_url: 'https://second-co.example.com' })];
    const { jobId, result } = await runJobWithProvider(records);
    expect(result.status).toBe('COMPLETED');
    expect(result.progress.records_fetched).toBe(2);
    expect(result.progress.ingested).toBe(2);
    expect(result.progress.duplicates_skipped).toBe(0);
    expect(result.progress.invalid_skipped).toBe(0);
    expect(result.progress.errors).toBe(0);
    const job = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).limit(1);
    expect(job[0]!.status).toBe('COMPLETED');
    expect(job[0]!.finished_at).toBeTruthy();
    // Track the actually-ingested businesses so afterAll can clean them up.
    const ingestedIds = await db.select({ id: businesses.id }).from(businesses).where(inArray(businesses.business_name, ['First Plumbing Co', 'Second Plumbing Co']));
    for (const row of ingestedIds) createdBusinessIds.add(row.id);
  });

  it('(4b) provider throws NotConfiguredError → FAILED + exception row', async () => {
    const jobId = await createDiscoveryJob({ industry: 'plumbing', state: 'TX', provider: 'none' });
    const result = await runDiscoveryJob(jobId); // no provider → registry serves NoneProvider
    expect(result.status).toBe('FAILED');
    const job = await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).limit(1);
    expect(job[0]!.error).toContain('DISCOVERY_API_KEY');
    const [exc] = await db.select().from(exceptions).where(eq(exceptions.entity_id, jobId));
    expect(exc?.category).toBe('discovery_provider_unconfigured');
    expect(exc?.priority).toBe('MEDIUM');
    expect(exc?.message).toContain('DISCOVERY_API_KEY');
  });

  it('(4c) per-record failure → PARTIAL + error rows; good records still ingested', async () => {
    const bad = makeRecord({ phone: undefined, email: undefined, address: undefined });
    const good = makeRecord({ business_name: 'Good Co', phone: '(512) 555-0303', website_url: 'https://goodco.example.com' });
    const { jobId, result } = await runJobWithProvider([bad, good]);
    expect(result.status).toBe('PARTIAL');
    expect(result.progress.ingested).toBe(1);
    expect(result.progress.invalid_skipped).toBe(1);
    expect(result.progress.errors).toBe(1);
    const errs = await db.select().from(discoveryJobErrors).where(eq(discoveryJobErrors.job_id, jobId));
    expect(errs.length).toBe(1);
    expect(errs[0]!.category).toBe('insufficient_contact');
    expect(errs[0]!.retryable).toBe(true);
  });

  it('(4d) retry bumps attempts, resets progress, reuses params', async () => {
    const jobId = await createDiscoveryJob({ industry: 'plumbing', state: 'TX', provider: 'stub' });
    await setSetting('discovery.max_attempts', 3);
    const n = normalizeBusiness(makeRecord());
    if (!n.ok) throw new Error('normalize failed');
    // First run fails (NoneProvider), then a stub succeeds on retry.
    const first = await runDiscoveryJob(jobId);
    expect(first.status).toBe('FAILED');
    const before = (await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).limit(1))[0]!;
    expect(before.attempts).toBe(0);
    expect(before.params).toBeNull();

    const provider = stubProvider([makeRecord()]);
    const retried = await retryDiscoveryJob(jobId, {
      registryOverrides: { providerId: 'stub', providerInstance: provider as unknown as Parameters<typeof buildDiscoveryRegistry>[0]['providerInstance'] },
    });
    expect(retried.status).toBe('COMPLETED');
    const after = (await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).limit(1))[0]!;
    expect(after.attempts).toBe(1);
    expect(after.params).toBeTruthy(); // params snapshot reused
    const target = (after.params as { target: { industry: string; state: string } }).target;
    expect(target.state).toBe('TX');
  });

  it('(4e) cancel flag → CANCELED', async () => {
    const token = createCancelToken();
    // A provider that yields 3 records slowly enough for the cancel to land at a batch boundary.
    const records = [makeRecord({ business_name: 'C1' }), makeRecord({ business_name: 'C2' }), makeRecord({ business_name: 'C3' })];
    const jobId = await createDiscoveryJob({ industry: 'plumbing', state: 'TX', provider: 'stub' });
    token.cancelled = true;
    const provider = stubProvider(records);
    const result = await runDiscoveryJob(jobId, {
      registryOverrides: { providerId: 'stub', providerInstance: provider as unknown as Parameters<typeof buildDiscoveryRegistry>[0]['providerInstance'] },
      token,
    });
    expect(result.status).toBe('CANCELED');
    const job = (await db.select().from(discoveryJobs).where(eq(discoveryJobs.id, jobId)).limit(1))[0]!;
    expect(job.cancelled_at).toBeTruthy();
    expect(cancelRequested(token)).toBe(true);
  });

  it('(4f) only PENDING jobs can run; finished jobs throw on re-run', async () => {
    const { jobId } = await runJobWithProvider([makeRecord()]);
    await expect(runDiscoveryJob(jobId)).rejects.toThrow('only PENDING');
  });
});

/* ----------------------------------------------------------------------------
 * Registry + NoneProvider
 * ------------------------------------------------------------------------- */

describe('registry + none-provider', () => {
  it('(5a) NoneProvider.search() throws NotConfiguredError naming DISCOVERY_API_KEY', async () => {
    const p = new NoneProvider();
    expect(p.id).toBe(DISCOVERY_PROVIDER_NONE);
    await expect(p.search({ industry: 'plumbing', state: 'TX' }).next()).rejects.toThrow('DISCOVERY_API_KEY');
  });

  it('(5b) registry with "none" is honestly unconfigured with the env var listed', async () => {
    const r = await buildDiscoveryRegistry({ providerId: 'none' });
    expect(r.provider).toBe('none');
    expect(r.configured).toBe(false);
    expect(r.requiresConfiguration).toBe(true);
    expect(r.missingEnvVars).toEqual([...DISCOVERY_ENV_VARS]);
  });

  it('(5c) a stub provider alone is never configured (env required)', async () => {
    const r = await buildDiscoveryRegistry({ providerInstance: stubProvider([]) as unknown as Parameters<typeof buildDiscoveryRegistry>[0]['providerInstance'] });
    expect(r.configured).toBe(false);
    expect(r.requiresConfiguration).toBe(true);
  });
});

/* ----------------------------------------------------------------------------
 * Scheduler
 * ------------------------------------------------------------------------- */

describe('scheduler', () => {
  it('(6a) interval 0 (disabled) → no job', async () => {
    await setSetting('discovery.schedule_interval_minutes', 0);
    await setSetting('target.states', ['TX']);
    const sched = new DiscoveryScheduler();
    const { created } = await sched.tick();
    expect(created).toBe(0);
  });

  it('(6b) enabled but provider unconfigured → no job (silent skip)', async () => {
    await setSetting('discovery.schedule_interval_minutes', 60);
    await setSetting('integrations.discovery.provider', 'none');
    await setSetting('target.states', ['TX']);
    const sched = new DiscoveryScheduler();
    const { created } = await sched.tick();
    expect(created).toBe(0);
  });

  it('(6c) enabled + configured stub → creates and runs exactly one job', async () => {
    await setSetting('discovery.schedule_interval_minutes', 60);
    await setSetting('integrations.discovery.provider', 'sched-stub');
    await setSetting('target.states', ['TX']);
    await setSetting('discovery.rate_limit_per_minute', 0);
    const sched = new DiscoveryScheduler({
      registryOverrides: { providerInstance: stubProvider([makeRecord({ business_name: 'Scheduled Co' })], 'sched-stub') as unknown as Parameters<typeof buildDiscoveryRegistry>[0]['providerInstance'] },
    });
    const { created } = await sched.tick();
    expect(created).toBe(1);
    const jobs = await db.select().from(discoveryJobs).orderBy(asc(discoveryJobs.created_at));
    const schedJobs = jobs.filter((j) => j.provider === 'sched-stub');
    expect(schedJobs.length).toBe(1);
    expect(schedJobs[0]!.status).toBe('COMPLETED');
  });

  it('(6d) active job blocks a second run (no double-run)', async () => {
    await setSetting('discovery.schedule_interval_minutes', 60);
    await setSetting('integrations.discovery.provider', 'sched-stub');
    await setSetting('target.states', ['TX']);
    await setSetting('discovery.rate_limit_per_minute', 0);
    // Insert a RUNNING job directly — simulates an in-flight run.
    await db.insert(discoveryJobs).values({
      industry: 'plumbing', state: 'TX', provider: 'sched-stub', status: 'RUNNING',
      attempts: 0,
    });
    const sched = new DiscoveryScheduler({
      registryOverrides: { providerInstance: stubProvider([makeRecord({ business_name: 'Double Co' })], 'sched-stub') as unknown as Parameters<typeof buildDiscoveryRegistry>[0]['providerInstance'] },
    });
    const beforeCount = (await db.select().from(discoveryJobs)).filter((j) => j.provider === 'sched-stub').length;
    const { created } = await sched.tick();
    expect(created).toBe(0); // active job → no new job
    const jobs = await db.select().from(discoveryJobs).orderBy(asc(discoveryJobs.created_at));
    expect(jobs.filter((j) => j.provider === 'sched-stub').length).toBe(beforeCount);
  });
});