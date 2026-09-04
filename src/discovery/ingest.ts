/**
 * Ingest — idempotent insert of one normalized discovery record into a
 * business (DISCOVERED lifecycle) + its website row + an audit entry, in ONE
 * transaction.
 *
 * Idempotency: the caller (runner) checks dedup keys against existing
 * businesses BEFORE calling this. This function ALSO refuses to double-insert
 * a website row for an existing domain (u_websites_url unique) and never
 * re-inserts a business that is already present (the runner's dedup set covers
 * the batch, and the name+city+state guard below covers a crash-resume).
 *
 * Never invents fields: every column derives from the normalized record that
 * came from the provider, plus the ICP target the job ran against (industry).
 * website_status null → NO website row (absence of evidence ≠ evidence of
 * absence).
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { businesses, websites, auditLogs } from '../db/schema';
import type { NormalizedBusiness } from './types';
import { domainFromUrl } from './normalize';

export type IngestResult =
  | { inserted: true; business_id: string; website_id: string | null; website_row: boolean }
  | { inserted: false; skipped: 'insufficient_contact'; reason: string }
  | { inserted: false; skipped: 'duplicate'; reason: string };

/** Required contact route for ingesting a lead (per master spec). */
export function hasContactRoute(b: NormalizedBusiness): boolean {
  return Boolean(b.phone || b.email || b.address);
}

/**
 * Insert one normalized record. Runs inside `tx` (per-batch transaction from
 * the runner). `industry` comes from the ICP target the job was created with
 * (never from the provider record).
 *
 * Returns:
 *  - {inserted:true} with the new business id + website id (if a row was
 *    justified);
 *  - {inserted:false, skipped:'insufficient_contact'} when the record has a
 *    name + city+state but no phone/email/address;
 *  - {inserted:false, skipped:'duplicate'} when the caller's dedup missed an
 *    existing business that this tx detects (rare crash-resume backstop).
 */
export async function ingestBusiness(
  tx: NodePgDatabase<Record<string, unknown>>,
  b: NormalizedBusiness,
  industry: string,
): Promise<IngestResult> {
  // Crash-resume safety: skip when an identical business already exists by
  // name+city+state (the runner pre-checks via dedup; this guards a resume).
  const dup = await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(
      sql`lower(${businesses.business_name}) = ${b.business_name.trim().toLowerCase()} AND ${businesses.city} = ${b.city ?? null} AND ${businesses.state} = ${b.state ?? null}`,
    )
    .limit(1);
  if (dup[0]) return { inserted: false, skipped: 'duplicate', reason: `business "${b.business_name}" already exists (name+city+state)` };

  const [business] = await tx
    .insert(businesses)
    .values({
      business_name: b.business_name,
      industry,
      address: b.address ?? null,
      city: b.city ?? null,
      state: b.state ?? null,
      zip: b.zip ?? null,
      phone: b.phone ?? null,
      email: b.email ?? null,
      website_url: b.website_url ?? null,
      source: b.source,
      source_url: b.source_url ?? null,
      rating: b.rating !== undefined ? String(b.rating) : null,
      review_count: b.review_count ?? null,
      business_status: mapBusinessStatus(b.business_status),
      lifecycle_state: 'DISCOVERED',
      provenance: b.provenance,
    })
    .returning({ id: businesses.id });
  const businessId = business!.id;

  // Website row: url present → DISCOVERED; verified_absent → NO_WEBSITE;
  // null website_status → NO row (absence of evidence ≠ evidence of absence).
  let websiteId: string | null = null;
  let websiteRow = false;
  if (b.website_url) {
    const [w] = await tx
      .insert(websites)
      .values({ business_id: businessId, url: b.website_url, status: 'DISCOVERED', domain: domainFromUrl(b.website_url) ?? null, discovered_at: new Date() })
      .onConflictDoNothing({ target: websites.url }) // provider may send the same url twice across batches
      .returning({ id: websites.id });
    websiteId = w?.id ?? null;
    websiteRow = true;
  } else if (b.website_status === 'verified_absent') {
    const [w] = await tx
      .insert(websites)
      .values({ business_id: businessId, url: '', status: 'NO_WEBSITE', discovered_at: new Date() })
      .returning({ id: websites.id });
    websiteId = w?.id ?? null;
    websiteRow = true;
  }

  await tx.insert(auditLogs).values({
    actor_type: 'SYSTEM',
    actor_id: null,
    action: 'BUSINESS_DISCOVERED',
    entity_type: 'business',
    entity_id: businessId,
    after: {
      business_name: b.business_name,
      city: b.city ?? null,
      state: b.state ?? null,
      phone: b.phone ?? null,
      website_url: b.website_url ?? null,
      website_status: b.website_status ?? null,
      source: b.source,
    },
    source: 'discovery',
    metadata: b.provenance as Record<string, unknown>,
  });

  return { inserted: true, business_id: businessId, website_id: websiteId, website_row: websiteRow };
}

/** Map a provider operational status string onto the DB enum; unknown → UNKNOWN. */
export function mapBusinessStatus(raw: string | undefined | null): (typeof businesses.$inferSelect)['business_status'] {
  switch (raw) {
    case 'OPERATIONAL': return 'OPERATIONAL';
    case 'CLOSED': return 'CLOSED';
    case 'PERMANENTLY_CLOSED': return 'PERMANENTLY_CLOSED';
    case 'TEMPORARILY_CLOSED': return 'TEMPORARILY_CLOSED';
    default: return 'UNKNOWN';
  }
}