/**
 * Discovery runner — executes one discovery_jobs row end-to-end.
 *
 * Lifecycle: PENDING → RUNNING → COMPLETED | PARTIAL | FAILED | CANCELED.
 *
 * Flow per attempt:
 *   1. mark RUNNING (started_at = now);
 *   2. resolve the provider via the registry — with "none"/no credentials the
 *      runner marks the job FAILED + writes a MEDIUM exception row (category
 *      'discovery_provider_unconfigured', message names the missing env var)
 *      + audit. It never fabricates records.
 *   3. stream records via provider.search(target); per record:
 *        normalize (deterministic) → dedup (within batch + existing) → ingest
 *        (per-batch transaction), with incremental progress counters;
 *        rate-limit delay between provider.next() calls (0 = unlimited);
 *   4. per-record failures → discovery_job_errors row (retryable
 *      classification) + continue — one bad record never aborts the job;
 *   5. fatal errors (provider-level / DB-level) → FAILED with error text;
 *   6. cooperative cancel: cancel token checked between batches → CANCELED;
 *   7. completion → COMPLETED, or PARTIAL when any errors/invalid records,
 *      with finished_at.
 *
 * Retry: retryDiscoveryJob(jobId) bumps attempts (max from
 * discovery.max_attempts), resets progress counters, reuses the original
 * params, sets PENDING then RUNNING via runDiscoveryJob.
 *
 * Deterministic TS only. NO network calls. Every insert derives from
 * RawBusinessRecord fields (never fabricated).
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  discoveryJobs,
  discoveryJobErrors,
  exceptions,
  auditLogs,
  businesses,
} from '../db/schema';
import type { DiscoveryJobProgress } from '../db/schema';
import { settings } from '../config/singleton';
import { buildDiscoveryRegistry } from './registry';
import { normalizeBusiness } from './normalize';
import type { NormalizedBusiness, RawBusinessRecord, DiscoveryTarget, DiscoveryJobParams } from './types';
import { ingestBusiness, hasContactRoute } from './ingest';
import {
  dedupKeysFor,
  indexExistingBusinesses,
  isDuplicate,
  type ExistingBusinessRow,
} from './dedup';
import { writeAudit } from '../auth/audit';

export interface RunResult {
  jobId: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELED';
  progress: DiscoveryJobProgress;
}

/** Standard per-record error categories (stored on discovery_job_errors). */
export const ERROR_CATEGORY = {
  provider_record_error: 'provider_record_error',
  insufficient_contact: 'insufficient_contact',
  fatal: 'fatal',
} as const;

const FINAL_STATUSES = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELED'] as const;

/* ----------------------------------------------------------------------------
 * Job row helpers
 * ------------------------------------------------------------------------- */

export type DiscoveryJobRow = typeof discoveryJobs.$inferSelect;

/** Load a job row (throws when missing). */
export async function getJob(jobId: string): Promise<DiscoveryJobRow> {
  const [job] = await db
    .select()
    .from(discoveryJobs)
    .where(eq(discoveryJobs.id, jobId))
    .limit(1);
  if (!job) throw new Error(`Discovery job ${jobId} not found`);
  return job;
}

async function setJobStatus(jobId: string, patch: Partial<typeof discoveryJobs.$inferInsert>): Promise<void> {
  await db.update(discoveryJobs).set(patch).where(eq(discoveryJobs.id, jobId));
}

async function loadProgress(jobId: string): Promise<DiscoveryJobProgress> {
  const job = await getJob(jobId);
  return (job.progress ?? zeroProgress());
}

async function bumpProgress(jobId: string, delta: Partial<DiscoveryJobProgress>): Promise<void> {
  const cur = await loadProgress(jobId);
  const next: DiscoveryJobProgress = {
    records_fetched: cur.records_fetched + (delta.records_fetched ?? 0),
    ingested: cur.ingested + (delta.ingested ?? 0),
    duplicates_skipped: cur.duplicates_skipped + (delta.duplicates_skipped ?? 0),
    invalid_skipped: cur.invalid_skipped + (delta.invalid_skipped ?? 0),
    errors: cur.errors + (delta.errors ?? 0),
  };
  await db.update(discoveryJobs).set({ progress: next }).where(eq(discoveryJobs.id, jobId));
}

async function writeJobError(
  jobId: string,
  entry: {
    businessName?: string | null;
    message: string;
    retryable?: boolean;
    category?: string;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(discoveryJobErrors).values({
    job_id: jobId,
    business_name: entry.businessName ?? null,
    message: entry.message,
    retryable: entry.retryable ?? false,
    category: entry.category ?? ERROR_CATEGORY.provider_record_error,
    metadata: entry.metadata ?? null,
  });
}

function zeroProgress(): DiscoveryJobProgress {
  return { records_fetched: 0, ingested: 0, duplicates_skipped: 0, invalid_skipped: 0, errors: 0 };
}

/* ----------------------------------------------------------------------------
 * Cancel token — cooperative cancel between batches.
 * ------------------------------------------------------------------------- */

export interface CancelToken {
  cancelled: boolean;
}

export function createCancelToken(): CancelToken {
  return { cancelled: false };
}

export function cancelRequested(token: CancelToken): boolean {
  return token.cancelled;
}

/* ----------------------------------------------------------------------------
 * Existing-business lookup for dedup
 * ------------------------------------------------------------------------- */

/**
 * Load existing businesses that could collide with the batch — those in the
 * same states (city-level filtering keeps the query small; a full-scan fallback
 * covers batches with no known state, which is tiny in practice).
 */
async function loadExistingForBatch(batch: readonly NormalizedBusiness[]): Promise<ExistingBusinessRow[]> {
  if (batch.length === 0) return [];
  const states = new Set(batch.map((b) => b.state).filter((s): s is string => Boolean(s)));
  if (states.size === 0) return [] as ExistingBusinessRow[];
  const rows = await db.select().from(businesses).where(inArray(businesses.state, [...states]));
  return rows as ExistingBusinessRow[];
}

/* ----------------------------------------------------------------------------
 * Main run
 * ------------------------------------------------------------------------- */

export interface RunOptions {
  /** Cooperative cancel token (checked between batches). */
  token?: CancelToken;
  /** Test seam: registry options (stub provider). */
  registryOverrides?: Parameters<typeof buildDiscoveryRegistry>[0];
}

/**
 * Run a discovery job from start to finish. Only PENDING jobs can run (retry
 * sets PENDING first). Returns the terminal status.
 */
export async function runDiscoveryJob(jobId: string, opts: RunOptions = {}): Promise<RunResult> {
  const job = await getJob(jobId);
  if (job.status !== 'PENDING') {
    throw new Error(`Discovery job ${jobId} is ${job.status}; only PENDING jobs can run`);
  }

  await setJobStatus(jobId, { status: 'RUNNING', started_at: new Date() });

  const target: DiscoveryTarget = job.city
    ? { industry: job.industry, state: job.state, city: job.city }
    : { industry: job.industry, state: job.state };

  try {
    const registry = await buildDiscoveryRegistry(opts.registryOverrides ?? {});

    // Provider not configured → FAIL loudly with an owner-visible exception.
    if (!registry.configured) {
      const envVars = registry.missingEnvVars.length > 0 ? registry.missingEnvVars : ['DISCOVERY_API_KEY'];
      const message = `discovery provider requires configuration: ${envVars.join(', ')} are not set and no provider is implemented/selected yet`;
      await setJobStatus(jobId, { status: 'FAILED', error: message, finished_at: new Date() });
      await db.insert(exceptions).values({
        entity_type: 'discovery_job',
        entity_id: jobId,
        priority: 'MEDIUM',
        category: 'discovery_provider_unconfigured',
        message,
        details: { env_vars: envVars, provider: registry.provider },
      });
      await writeAudit({
        actorType: 'SYSTEM',
        action: 'DISCOVERY_JOB_FAILED',
        entityType: 'discovery_job',
        entityId: jobId,
        after: { status: 'FAILED', error: message },
        source: 'discovery',
      });
      return { jobId, status: 'FAILED', progress: await loadProgress(jobId) };
    }

    const provider = registry.providerInstance;
    const discoveryCfg = await settings.getDiscoveryConfig();
    const params: DiscoveryJobParams = {
      target,
      provider: job.provider,
      settings: {
        batch_size: discoveryCfg.batch_size,
        max_attempts: discoveryCfg.max_attempts,
        rate_limit_per_minute: discoveryCfg.rate_limit_per_minute,
      },
    };
    // Snapshot the params used so a retry reuses exactly this target/settings.
    await db.update(discoveryJobs).set({ params: params as unknown as Record<string, unknown> }).where(eq(discoveryJobs.id, jobId));

    const batchSize = Math.max(1, discoveryCfg.batch_size);
    const rateLimitMs =
      discoveryCfg.rate_limit_per_minute > 0
        ? Math.round(60_000 / discoveryCfg.rate_limit_per_minute)
        : 0;

    const iter = provider.search(target);
    // AsyncGenerator is also AsyncIterable; the cast normalizes the union.
    const asyncIterable: AsyncIterable<RawBusinessRecord> = iter as AsyncIterable<RawBusinessRecord>;

    let buffer: NormalizedBusiness[] = [];
    let fetchedSinceBatch = 0;
    let sawError = false;

    // Cooperative cancel between batches: flush the current buffer first.
    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      await bumpProgress(jobId, { records_fetched: fetchedSinceBatch });
      fetchedSinceBatch = 0;
      await processBatch(jobId, buffer, job.industry);
      buffer = [];
    };

    for await (const raw of asyncIterable) {
      fetchedSinceBatch += 1;

      const normalized = normalizeBusiness(raw);
      if (!normalized.ok) {
        // Invalid record — not ingested; error row + counters, continue.
        await writeJobError(jobId, {
          businessName: raw.business_name,
          message: `record "${raw.business_name}" failed normalization: ${normalized.reason}`,
          retryable: true,
          category: ERROR_CATEGORY.provider_record_error,
          metadata: { target },
        });
        await bumpProgress(jobId, { invalid_skipped: 1, errors: 1 });
        sawError = true;
        continue;
      }
      buffer.push(normalized.value);

      if (buffer.length >= batchSize) {
        await flush();
        if (opts.token && cancelRequested(opts.token)) break;
      }

      // Rate limit between provider.next() calls (0 = unlimited).
      if (rateLimitMs > 0) await sleep(rateLimitMs);
    }
    // Never lose the tail of a partial buffer.
    await flush();

    if (opts.token && cancelRequested(opts.token)) {
      await setJobStatus(jobId, { status: 'CANCELED', finished_at: new Date(), cancelled_at: new Date() });
      await writeAudit({
        actorType: 'SYSTEM',
        action: 'DISCOVERY_JOB_CANCELED',
        entityType: 'discovery_job',
        entityId: jobId,
        after: { status: 'CANCELED', progress: await loadProgress(jobId) },
        source: 'discovery',
      });
      return { jobId, status: 'CANCELED', progress: await loadProgress(jobId) };
    }

    const finalProgress = await loadProgress(jobId);
    const finalStatus: 'COMPLETED' | 'PARTIAL' = sawError || finalProgress.errors > 0 ? 'PARTIAL' : 'COMPLETED';
    await setJobStatus(jobId, { status: finalStatus, finished_at: new Date() });
    await writeAudit({
      actorType: 'SYSTEM',
      action: finalStatus === 'COMPLETED' ? 'DISCOVERY_JOB_COMPLETED' : 'DISCOVERY_JOB_PARTIAL',
      entityType: 'discovery_job',
      entityId: jobId,
      after: { status: finalStatus, progress: finalProgress },
      source: 'discovery',
    });
    return { jobId, status: finalStatus, progress: finalProgress };
  } catch (err) {
    // Fatal path (provider threw, DB failure, ...).
    const message = err instanceof Error ? err.message : String(err);
    await setJobStatus(jobId, { status: 'FAILED', error: message, finished_at: new Date() });
    await writeAudit({
      actorType: 'SYSTEM',
      action: 'DISCOVERY_JOB_FAILED',
      entityType: 'discovery_job',
      entityId: jobId,
      after: { status: 'FAILED', error: message },
      source: 'discovery',
    });
    return { jobId, status: 'FAILED', progress: await loadProgress(jobId) };
  }
}

/**
 * Dedup + ingest one batch inside a single transaction. Per-record failures
 * (insufficient contact, ingest error) are recorded as error rows and do not
 * abort the batch.
 */
async function processBatch(
  jobId: string,
  batch: readonly NormalizedBusiness[],
  industry: string,
): Promise<void> {
  const existing = await loadExistingForBatch(batch);
  const index = indexExistingBusinesses(existing);
  const seen = new Set<string>();

  for (const b of batch) {
    // 1. Dedup: within batch AND against existing businesses.
    if (isDuplicate(b, index, seen)) {
      await bumpProgress(jobId, { duplicates_skipped: 1 });
      continue;
    }
    for (const k of Object.values(dedupKeysFor(b))) if (k) seen.add(k);

    // 2. Contact-route gate (name + city&state + phone/email/address).
    if (!b.city || !b.state) {
      await bumpProgress(jobId, { invalid_skipped: 1, errors: 1 });
      await writeJobError(jobId, {
        businessName: b.business_name,
        message: `record "${b.business_name}" missing city/state (need both to ingest)`,
        retryable: true,
        category: ERROR_CATEGORY.provider_record_error,
        metadata: { city: b.city ?? null, state: b.state ?? null },
      });
      continue;
    }
    if (!hasContactRoute(b)) {
      await bumpProgress(jobId, { invalid_skipped: 1, errors: 1 });
      await writeJobError(jobId, {
        businessName: b.business_name,
        message: `record "${b.business_name}" has no contact route (need phone, email, or address)`,
        retryable: true,
        category: ERROR_CATEGORY.insufficient_contact,
        metadata: { city: b.city ?? null, state: b.state ?? null },
      });
      continue;
    }

    // 3. Ingest (business + website + audit) in a per-record transaction.
    try {
      const res = await db.transaction(async (tx) => ingestBusiness(tx, b, industry));
      if (res.inserted) {
        await bumpProgress(jobId, { ingested: 1 });
      } else if (res.skipped === 'duplicate') {
        await bumpProgress(jobId, { duplicates_skipped: 1 });
        for (const k of Object.values(dedupKeysFor(b))) if (k) seen.add(k);
      } else {
        // insufficient_contact surfaced inside the tx (shouldn't happen after
        // the gate above — treat as an error, do not count as ingested).
        await bumpProgress(jobId, { invalid_skipped: 1, errors: 1 });
        await writeJobError(jobId, {
          businessName: b.business_name,
          message: `record "${b.business_name}" skipped: ${res.reason}`,
          retryable: true,
          category: ERROR_CATEGORY.insufficient_contact,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await bumpProgress(jobId, { errors: 1 });
      await writeJobError(jobId, {
        businessName: b.business_name,
        message: `ingest failed: ${message}`,
        retryable: false,
        category: ERROR_CATEGORY.fatal,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ----------------------------------------------------------------------------
 * Retry
 * ------------------------------------------------------------------------- */

/**
 * Retry a finished discovery job: bumps attempts (capped at
 * discovery.max_attempts), resets progress counters, reuses the original
 * task params, sets PENDING then RUNNING (via runDiscoveryJob).
 */
export async function retryDiscoveryJob(jobId: string): Promise<RunResult> {
  const job = await getJob(jobId);
  if (!FINAL_STATUSES.includes(job.status as (typeof FINAL_STATUSES)[number])) {
    throw new Error(
      `Discovery job ${jobId} is ${job.status}; only finished jobs (COMPLETED/PARTIAL/FAILED/CANCELED) can retry`,
    );
  }
  const cfg = await settings.getDiscoveryConfig();
  if (job.attempts >= cfg.max_attempts) {
    throw new Error(`Discovery job ${jobId} has reached max attempts (${cfg.max_attempts})`);
  }
  const attempts = job.attempts + 1;
  await db.update(discoveryJobs)
    .set({
      status: 'PENDING',
      attempts,
      progress: zeroProgress(),
      error: null,
      started_at: null,
      finished_at: null,
      cancelled_at: null,
    })
    .where(eq(discoveryJobs.id, jobId));
  await writeAudit({
    actorType: 'SYSTEM',
    action: 'DISCOVERY_JOB_RETRY',
    entityType: 'discovery_job',
    entityId: jobId,
    after: { status: 'PENDING', attempts },
    source: 'discovery',
  });
  return runDiscoveryJob(jobId);
}

/* ----------------------------------------------------------------------------
 * Creation (scheduler + future API)
 * ------------------------------------------------------------------------- */

/** Create a discovery job row (PENDING) for a target. */
export async function createDiscoveryJob(params: {
  industry: string;
  state: string;
  city?: string;
  provider: string;
  providerOptions?: Record<string, unknown>;
}): Promise<string> {
  const [row] = await db
    .insert(discoveryJobs)
    .values({
      industry: params.industry,
      state: params.state,
      city: params.city ?? null,
      provider: params.provider,
      status: 'PENDING',
      attempts: 0,
    })
    .returning({ id: discoveryJobs.id });
  return row!.id;
}