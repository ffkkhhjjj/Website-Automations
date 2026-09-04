/**
 * Dedup for discovery — pure, deterministic, tested.
 *
 * A record is a duplicate if ANY of its dedup keys already exists in the
 * database (existing businesses) or was already seen in this batch:
 *  (a) normalized phone (exact match on normalized digits/E.164 form)
 *  (b) normalized domain derived from website_url
 *  (c) lowercased business_name + city + state
 *
 * Keys are only computed when the underlying data exists — a record with no
 * phone/website/complete name+city+state simply has no key for that dimension
 * (absence of evidence). Every key is deterministic, so the same provider
 * record dedups identically on a retry.
 *
 * The runner loads existing businesses (and website domains) from the DB and
 * builds an ExistingBusinessKeyIndex with `indexExistingBusinesses`; within
 * the batch, a `seen` set prevents double-inserts. Everything here is pure —
 * no DB access in this module.
 */
import type { NormalizedBusiness } from './types';
import { domainFromUrl, normalizePhone } from './normalize';

/** One dedup key for a normalized record (only the dimensions that exist). */
export interface DedupKeys {
  phone?: string;
  domain?: string;
  nameCityState?: string;
}

/** Compute the dedup keys for a normalized record (pure). */
export function dedupKeysFor(b: NormalizedBusiness): DedupKeys {
  const keys: DedupKeys = {};
  if (b.phone) keys.phone = normalizePhone(b.phone) ?? undefined;
  if (b.website_url) {
    const d = domainFromUrl(b.website_url);
    if (d) keys.domain = d;
  }
  if (b.business_name && b.city && b.state) {
    keys.nameCityState =
      [b.business_name.trim().toLowerCase(), b.city.trim().toLowerCase(), b.state.trim().toUpperCase()].join('|');
  }
  return keys;
}

/** All present keys of a record as a set. */
export function dedupKeySet(keys: DedupKeys): Set<string> {
  const s = new Set<string>();
  for (const v of [keys.phone, keys.domain, keys.nameCityState]) {
    if (v !== undefined && v !== null && v.length > 0) s.add(v);
  }
  return s;
}

/** Union of key sets from all records (within-batch seen set). */
export function seenKeySet(records: readonly NormalizedBusiness[]): Set<string> {
  const s = new Set<string>();
  for (const r of records) {
    for (const k of dedupKeySet(dedupKeysFor(r))) s.add(k);
  }
  return s;
}

/** Minimal existing-business shape the index needs. */
export interface ExistingBusinessRow {
  id: string;
  business_name: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  website_url: string | null;
}

/**
 * Normalized dedup keys for an EXISTING business (any stored form the DB may
 * hold — legacy rows were not stored through our normalizers).
 */
export function existingKeysFor(p: ExistingBusinessRow): DedupKeys {
  return {
    phone: p.phone ? normalizePhone(p.phone) ?? undefined : undefined,
    domain: p.website_url ? domainFromUrl(p.website_url) ?? undefined : undefined,
    nameCityState:
      p.business_name && p.city && p.state
        ? [p.business_name.trim().toLowerCase(), p.city.trim().toLowerCase(), p.state.trim().toUpperCase()].join('|')
        : undefined,
  };
}

/**
 * Build the dedup context for a discovery batch (the shape the spec asks for):
 *  - `existing`: the businesses already in the DB (caller loads them);
 *  - `seen`: within-batch keys so two records in one provider run that share a
 *    phone/domain/name+city+state don't double-insert.
 */
export function buildDedupContext(
  batch: readonly NormalizedBusiness[],
  existing: readonly ExistingBusinessRow[],
): { existing: readonly ExistingBusinessRow[]; seen: Set<string> } {
  return { existing, seen: seenKeySet(batch) };
}

/**
 * Key index over existing businesses for O(1) duplicate checks. Keys map to
 * the business id; a key may collide with several businesses (same phone on
 * multiple listings) and any hit means duplicate.
 */
export interface ExistingBusinessKeyIndex {
  phone: Map<string, string>;
  domain: Map<string, string>;
  nameCityState: Map<string, string>;
}

/** Index existing businesses by their dedup keys (pure). */
export function indexExistingBusinesses(rows: readonly ExistingBusinessRow[]): ExistingBusinessKeyIndex {
  const index: ExistingBusinessKeyIndex = { phone: new Map(), domain: new Map(), nameCityState: new Map() };
  for (const p of rows) {
    const k = existingKeysFor(p);
    if (k.phone && !index.phone.has(k.phone)) index.phone.set(k.phone, p.id);
    if (k.domain && !index.domain.has(k.domain)) index.domain.set(k.domain, p.id);
    if (k.nameCityState && !index.nameCityState.has(k.nameCityState)) index.nameCityState.set(k.nameCityState, p.id);
  }
  return index;
}

/** True when any key of the record exists in the index or in the batch `seen` set. */
export function isDuplicate(
  record: NormalizedBusiness,
  index: ExistingBusinessKeyIndex,
  seen: ReadonlySet<string>,
): boolean {
  const keys = dedupKeysFor(record);
  if (keys.phone && (seen.has(keys.phone) || index.phone.has(keys.phone))) return true;
  if (keys.domain && (seen.has(keys.domain) || index.domain.has(keys.domain))) return true;
  if (keys.nameCityState && (seen.has(keys.nameCityState) || index.nameCityState.has(keys.nameCityState))) return true;
  return false;
}