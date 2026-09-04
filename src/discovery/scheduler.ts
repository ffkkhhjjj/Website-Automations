/**
 * Discovery scheduler — periodically creates + runs discovery jobs from the
 * ICP target settings (industries × states, cities when configured).
 *
 * Guards (brief 8A):
 *  - interval 0 (default) → disabled, nothing runs;
 *  - provider unconfigured → skip silently (NO error spam — the runner's
 *    honest FAILED path still fires when a job is manually created);
 *  - single active job: never create a second job while one is RUNNING or
 *    PENDING.
 *
 * Wiring into src/index.ts happens in brief 8B — this module only delivers the
 * service (start/stop) + tests. Jobs created by the scheduler are executed
 * in-process (single-writer per the team convention).
 */
import { inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { discoveryJobs } from '../db/schema';
import { settings } from '../config/singleton';
import { buildDiscoveryRegistry } from './registry';
import { createDiscoveryJob, runDiscoveryJob } from './runner';

export interface DiscoverySchedulerOptions {
  /** Test seam: registry options (stub provider). */
  registryOverrides?: Parameters<typeof buildDiscoveryRegistry>[0];
  /** Test seam: override the interval for fast deterministic tests. */
  intervalMinutesOverride?: number;
}

export class DiscoveryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: DiscoverySchedulerOptions;

  constructor(opts: DiscoverySchedulerOptions = {}) {
    this.opts = opts;
  }

  /** True while a discovery job is RUNNING or PENDING. */
  async hasActiveJob(): Promise<boolean> {
    const rows = await db
      .select({ id: discoveryJobs.id })
      .from(discoveryJobs)
      .where(inArray(discoveryJobs.status, ['RUNNING', 'PENDING']))
      .limit(1);
    return rows.length > 0;
  }

  /** The ICP target settings → one job target per (industry × state [× city]). */
  async buildJobTargets(): Promise<{ industry: string; state: string; city?: string }[]> {
    const [industries, states, cities] = await Promise.all([
      settings.getTargetIndustries(),
      settings.getTargetStates(),
      settings.getTargetCities(),
    ]);
    // No-op unless both industries AND states are configured.
    if (industries.length === 0 || states.length === 0) return [];
    const targets: { industry: string; state: string; city?: string }[] = [];
    for (const industry of industries) {
      for (const state of states) {
        if (cities.length > 0) {
          for (const city of cities) targets.push({ industry, state, city });
        } else {
          targets.push({ industry, state });
        }
      }
    }
    return targets;
  }

  /** Interval in ms for this scheduler instance (override wins). */
  async intervalMs(): Promise<number> {
    const interval = this.opts.intervalMinutesOverride ?? (await settings.getDiscoveryConfig()).schedule_interval_minutes;
    return Math.max(interval, 1) * 60_000;
  }

  /**
   * Run one scheduler tick. Guards: interval disabled → no job; provider
   * unconfigured → silent skip; active job → no new job (single-writer).
   * Returns how many jobs were created.
   */
  async tick(): Promise<{ created: number }> {
    const interval = this.opts.intervalMinutesOverride ?? (await settings.getDiscoveryConfig()).schedule_interval_minutes;
    if (interval <= 0) return { created: 0 }; // disabled

    const registry = await buildDiscoveryRegistry(this.opts.registryOverrides ?? {});
    if (!registry.configured) return { created: 0 }; // unconfigured → silent skip

    const targets = await this.buildJobTargets();
    if (targets.length === 0) return { created: 0 };

    if (await this.hasActiveJob()) return { created: 0 }; // single active job

    let created = 0;
    for (const target of targets) {
      // Re-check the guard between targets (another tick may have started).
      if (await this.hasActiveJob()) break;
      const jobId = await createDiscoveryJob({
        industry: target.industry,
        state: target.state,
        city: target.city,
        provider: registry.provider,
      });
      created += 1;
      // Run in-process; runDiscoveryJob returns FAILED for provider/record
      // errors instead of throwing — the catch below is only a safety net.
      const p = runDiscoveryJob(jobId, { registryOverrides: this.opts.registryOverrides });
      p.catch(() => undefined);
      await p;
    }
    return { created };
  }

  /** Start the interval loop (no-op when disabled or already started). */
  start(): void {
    if (this.timer !== null) return;
    void (async () => {
      const ms = await this.intervalMs().catch(() => 0);
      if (ms <= 0) return; // disabled
      this.timer = setInterval(() => {
        this.tick().catch(() => undefined);
      }, ms);
    })();
  }

  /** Stop the interval loop (idempotent). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Convenience gate used by the future API wiring. */
export async function isDiscoveryEnabledAndConfigured(): Promise<boolean> {
  if ((await settings.getDiscoveryConfig()).schedule_interval_minutes <= 0) return false;
  return (await buildDiscoveryRegistry()).configured;
}