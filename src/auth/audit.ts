/**
 * Audit helper — append-only auth event logging to audit_logs.
 *
 * Schema constraints (see src/db/schema.ts):
 *  - actor_type is a pg enum with values 'SYSTEM' | 'USER' | 'API' | 'JOB'.
 *  - entity_id is NOT NULL uuid, so every auth event must reference an entity.
 *  - before/after/metadata are JSONB.
 */
import { db } from '../db/client';
import { auditLogs } from '../db/schema';

export type AuditActorType = 'SYSTEM' | 'USER' | 'API' | 'JOB';

export interface AuditEvent {
  actorType: AuditActorType;
  /** Actor id — userId for USER, apiKey row id for API, null for SYSTEM/JOB. */
  actorId?: string | null;
  action: string;
  /** Target entity type, e.g. 'user', 'api_key', 'user_session'. */
  entityType: string;
  /** Target entity id (audit_logs.entity_id is NOT NULL). */
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Write one audit row. Throws if the write fails (audit events are treated as
 * load-bearing: login/key events must not silently disappear).
 */
export async function writeAudit(event: AuditEvent): Promise<void> {
  await db.insert(auditLogs).values({
    actor_type: event.actorType,
    actor_id: event.actorId ?? null,
    action: event.action,
    entity_type: event.entityType,
    entity_id: event.entityId,
    before: event.before ?? null,
    after: event.after ?? null,
    source: 'auth',
    metadata: event.metadata ?? null,
  });
}

/** Convenience: audit a user-scoped event. */
export function auditUser(opts: {
  userId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  return writeAudit({
    actorType: 'USER',
    actorId: opts.userId,
    action: opts.action,
    entityType: opts.entityType ?? 'user',
    entityId: opts.entityId ?? opts.userId,
    before: opts.before ?? null,
    after: opts.after ?? null,
    metadata: opts.metadata ?? null,
  });
}

/** Convenience: audit an API-key-scoped event. */
export function auditApiKey(opts: {
  apiKeyId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  return writeAudit({
    actorType: 'API',
    actorId: opts.apiKeyId,
    action: opts.action,
    entityType: opts.entityType ?? 'api_key',
    entityId: opts.entityId ?? opts.apiKeyId,
    before: opts.before ?? null,
    after: opts.after ?? null,
    metadata: opts.metadata ?? null,
  });
}

/** Convenience: audit a system event (bootstrap, revocations). */
export function auditSystem(opts: {
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  return writeAudit({
    actorType: 'SYSTEM',
    actorId: null,
    action: opts.action,
    entityType: opts.entityType,
    entityId: opts.entityId,
    before: opts.before ?? null,
    after: opts.after ?? null,
    metadata: opts.metadata ?? null,
  });
}