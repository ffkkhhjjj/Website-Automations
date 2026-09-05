/**
 * Deterministic normalizers for raw provider records — NO network calls, NO AI,
 * NO invented data. Every function is a pure transform of the input; anything
 * that does not pass a validator is dropped or rejects the record (state), so
 * the pipeline can never persist garbage or fabricate a value.
 *
 * Provenance: every normalized record carries, per field, where the field came
 * from (provider source + source_url) and the ORIGINAL raw value — the same
 * contract the DB `provenance` jsonb column documents.
 */
import type { NormalizedBusiness, RawBusinessRecord } from './types';

/** US states + DC (2-letter); territories excluded for the ICP US scope. */
export const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
]);

/** trim + collapse internal whitespace. */
export function normalizeName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : null;
}

/**
 * Phone → normalized digits, E.164-ish.
 *  - 10 digits → +1<digits> (US default country code)
 *  - 11 digits starting with 1 → +1<last 10>
 *  - anything else → raw digits (honest; not re-interpreted)
 *  - empty/non-parseable → null
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+1${digits.slice(1)}`;
  return digits;
}

/** Email → lowercase/trimmed; must look like an address. Invalid → null. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

/** State → 2-letter uppercase. Invalid or non-US → null. */
export function normalizeState(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return null;
  return US_STATES.has(s) ? s : null;
}

/** Zip → first 5 digits (US ZIP). Fewer than 5 digits → null. */
export function normalizeZip(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

/**
 * Domain derived from a website URL (hostname, lowercased, www. stripped).
 * No network — pure string/URL parsing. Unparseable → null.
 */
export function domainFromUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host.length > 0 ? host : null;
  } catch {
    // last-resort regex parse (no network involved)
    const m = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
    if (!m || !m[1]) return null;
    const host = m[1].toLowerCase();
    return host.length > 0 ? host : null;
  }
}

/** Trimmed URL (never invents a scheme — kept as provided). */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/** rating 0–5 else null; review_count non-negative integer else null. */
function normalizeRating(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw >= 0 && raw <= 5 ? raw : null;
}
function normalizeReviewCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  return raw >= 0 ? raw : null;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedBusiness }
  | { ok: false; reason: string };

/** Per-field provenance from the raw record. */
function provenanceFor(
  raw: RawBusinessRecord,
  fields: readonly (keyof RawBusinessRecord)[],
): Record<string, { source: string; source_url?: string; value: unknown }> {
  const out: Record<string, { source: string; source_url?: string; value: unknown }> = {};
  for (const f of fields) {
    const v = raw[f];
    if (v === undefined || v === null || v === '') continue;
    out[String(f)] = {
      source: raw.source,
      ...(raw.source_url ? { source_url: raw.source_url } : {}),
      value: v,
    };
  }
  return out;
}

/**
 * Deterministic normalization of one raw provider record.
 * Rejects (ok:false) when the record carries an INVALID state — the pipeline
 * must never ingest a business into the wrong state. Missing optional fields
 * are dropped, not invented.
 */
export function normalizeBusiness(raw: RawBusinessRecord): NormalizeResult {
  const name = normalizeName(raw.business_name);
  if (!name) return { ok: false, reason: 'business_name missing or blank' };

  const state = normalizeState(raw.state);
  // state present-but-invalid → reject the record (never guess a state)
  if (raw.state !== undefined && raw.state !== null && raw.state.trim() !== '' && !state) {
    return { ok: false, reason: `invalid US state "${raw.state.trim()}" (expected 2-letter code)` };
  }

  const website_status =
    raw.website_status === 'present' || raw.website_status === 'verified_absent'
      ? raw.website_status
      : null;

  const value: NormalizedBusiness = {
    external_id: raw.external_id !== undefined ? String(raw.external_id).trim() || undefined : undefined,
    business_name: name,
    address: normalizeName(raw.address) ?? undefined,
    city: normalizeName(raw.city) ?? undefined,
    state: state ?? undefined,
    zip: normalizeZip(raw.zip) ?? undefined,
    phone: normalizePhone(raw.phone) ?? undefined,
    email: normalizeEmail(raw.email) ?? undefined,
    website_url: normalizeUrl(raw.website_url) ?? undefined,
    website_status: website_status ?? undefined,
    rating: normalizeRating(raw.rating) ?? undefined,
    review_count: normalizeReviewCount(raw.review_count) ?? undefined,
    business_status:
      raw.business_status !== undefined && raw.business_status !== null && String(raw.business_status).trim() !== ''
        ? String(raw.business_status).trim()
        : undefined,
    source: raw.source,
    source_url: raw.source_url !== undefined ? String(raw.source_url).trim() || undefined : undefined,
    provenance: provenanceFor(raw, [
      'external_id', 'business_name', 'address', 'city', 'state', 'zip', 'phone',
      'email', 'website_url', 'website_status', 'rating', 'review_count', 'business_status',
    ]),
  };
  return { ok: true, value };
}