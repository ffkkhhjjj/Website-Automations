/**
 * Discovery module types — the contracts for automatically discovering
 * legitimate US local businesses (plumbers first) matching the ICP target
 * settings (target.industries / target.states / target.cities).
 *
 * Honesty rules (mirror src/integrations/types.ts):
 *  - a provider returns ONLY fields it actually found in legitimate public
 *    sources; absent field = "not found", never a fabricated value;
 *  - `website_status` distinguishes a CONFIRMED absence of a website
 *    ('verified_absent') from "we didn't look" (null) — the ingest layer treats
 *    null exactly as "no evidence", so no website row is created;
 *  - no network calls anywhere in this module: the real data source is a
 *    swappable provider selected in settings; with "none" the registry serves
 *    NoneProvider, whose `search()` THROWS (never fake records).
 */

/** One ICP discovery target: industry × state, city optional. */
export interface DiscoveryTarget {
  industry: string;
  state: string;
  city?: string;
}

/**
 * A raw record exactly as the provider supplies it. Every field is optional
 * except business_name — providers never invent what they did not find.
 */
export interface RawBusinessRecord {
  /** Provider-side stable id (their listing id, not ours). */
  external_id?: string;
  business_name: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  email?: string;
  website_url?: string;
  /** 'present' = provider saw a website; 'verified_absent' = provider verified
   *  there is none; null = provider did not look (absence of evidence). */
  website_status?: 'present' | 'verified_absent' | null;
  /** Star rating (0–5) from a public review source. */
  rating?: number;
  review_count?: number;
  /** Operational status if the provider knows it. */
  business_status?: string;
  /** Data source + provenance (e.g. source: 'google_maps'). */
  source: string;
  source_url?: string;
  /** The full raw payload, verbatim, for later re-processing. */
  raw?: Record<string, unknown>;
}

/**
 * A normalized record after deterministic normalization (src/discovery/normalize.ts).
 * `provenance` preserves, per field, where that field came from and its
 * original value — the DB provenance jsonb is built from this.
 */
export interface NormalizedBusiness {
  external_id?: string;
  business_name: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string; // normalized E.164-ish digits
  email?: string; // lowercase/trimmed
  website_url?: string;
  website_status?: 'present' | 'verified_absent' | null;
  rating?: number;
  review_count?: number;
  business_status?: string;
  source: string;
  source_url?: string;
  provenance: Record<string, { source: string; source_url?: string; value: unknown }>;
}

/** A provider-specific target + the execution settings snapshot for a job. */
export interface DiscoveryJobParams {
  target: DiscoveryTarget;
  provider: string;
  /** Snapshot of the discovery.* runtime settings the job ran with. */
  settings?: {
    batch_size: number;
    max_attempts: number;
    rate_limit_per_minute: number;
  };
}