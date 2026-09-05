/**
 * Discovery providers — the seam between the discovery pipeline and real data
 * sources (Google Maps, Yelp, local directories, ...).
 *
 * Honesty rule (same as src/integrations/*): until a REAL provider is
 * implemented, selected in settings, and has DISCOVERY_API_KEY in env, the
 * registry serves NoneProvider, whose `search()` THROWS — the pipeline never
 * pretends records arrived. No fabricated data, no scraping of restricted
 * services, no network calls from this module: providers are pure interfaces
 * here.
 */
import type { DiscoveryTarget, RawBusinessRecord } from './types';

/** Env var a real discovery provider needs (documented, mirrors
 *  src/integrations MODULE_ENV_VARS conventions). */
export const DISCOVERY_ENV_VARS = ['DISCOVERY_API_KEY'] as const;

/** Provider id for "no provider selected" (mirrors integrations "none"). */
export const DISCOVERY_PROVIDER_NONE = 'none';

/** The one runtime error an unconfigured discovery provider produces. */
export class NotConfiguredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        `discovery provider requires configuration: ${DISCOVERY_ENV_VARS.join(', ')} ` +
          `are not set and no provider is implemented/selected yet`,
    );
    this.name = 'NotConfiguredError';
  }
}

/**
 * DiscoveryProvider — yields raw business records for one ICP target.
 *
 * Contract:
 *  - async generator (or any AsyncIterable) — records stream in so the runner
 *    can normalize → dedup → ingest per batch and rate-limit between fetches;
 *  - returns ONLY records the provider actually found in legitimate public
 *    sources; never synthesizes businesses, contact info, or websites;
 *  - `id` is the provider's stable identifier (mirrors integrations `name`).
 */
export interface DiscoveryProvider {
  readonly id: string;
  search(target: DiscoveryTarget): AsyncGenerator<RawBusinessRecord> | AsyncIterable<RawBusinessRecord>;
}

/**
 * NoneProvider — the ONLY provider until a real one exists. Its `search()`
 * throws NotConfiguredError naming the missing env var. By design there is no
 * "local stub that answers": calling discovery with no provider FAILS LOUDLY
 * instead of silently pretending the work happened.
 */
export class NoneProvider implements DiscoveryProvider {
  readonly id = DISCOVERY_PROVIDER_NONE;

  search(): AsyncGenerator<RawBusinessRecord> {
    return (async function* (): AsyncGenerator<RawBusinessRecord> {
      throw new NotConfiguredError();
    })();
  }
}