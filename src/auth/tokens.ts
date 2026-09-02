/**
 * JWT access tokens + rotating refresh tokens.
 *
 * Access tokens are short-lived JWTs signed with the env-provided secret.
 * Refresh tokens are random 256-bit values; ONLY their SHA-256 hex hash is
 * stored in user_sessions (never the token itself). Every refresh rotates the
 * token: the old session row is revoked and a new one inserted — a replay of
 * an already-rotated refresh token is therefore rejected.
 */
import { randomBytes, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { userSessions, users } from '../db/schema';
import type { AuthConfig } from './config';

export const ACCESS_TOKEN_ALGO = 'HS256';
export const REFRESH_TOKEN_BYTES = 32;

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  role: 'OWNER';
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string; // user id
  jti: string; // session row id
  type: 'refresh';
}

/** sha256 hex of a refresh token — the only representation persisted. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Sign a short-lived access token for a user. */
export function signAccessToken(user: { id: string; email: string; role: 'OWNER' }, cfg: AuthConfig): string {
  const payload: AccessTokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    type: 'access',
  };
  // expiresIn is a jsonwebtoken StringValue (e.g. '15m'); widen the type since
  // the value comes from env.
  const options = { algorithm: ACCESS_TOKEN_ALGO, expiresIn: cfg.jwtExpiresIn } as jwt.SignOptions;
  return jwt.sign(payload, cfg.jwtSecret, options);
}

/** Verify an access token. Throws on invalid/expired/token-type mismatch. */
export function verifyAccessToken(token: string, cfg: AuthConfig): AccessTokenPayload {
  const decoded = jwt.verify(token, cfg.jwtSecret, { algorithms: [ACCESS_TOKEN_ALGO] });
  if (typeof decoded === 'string' || decoded.type !== 'access') {
    throw new Error('Not an access token');
  }
  return {
    sub: String(decoded.sub),
    email: String(decoded.email),
    role: 'OWNER',
    type: 'access',
  };
}

/** Generate a fresh random refresh token (returns raw value; caller stores the hash). */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
}

/**
 * Store a refresh-token session row. Returns the raw token and the row.
 * If `replacingSessionId` is given (rotation), that old session is revoked first.
 */
export async function issueRefreshSession(
  user: { id: string },
  opts: { refreshTtlDays: number; userAgent?: string | null; ipAddress?: string | null; replacingSessionId?: string },
): Promise<{ rawToken: string; sessionId: string; expiresAt: Date }> {
  const rawToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(rawToken);
  const expiresAt = new Date(Date.now() + opts.refreshTtlDays * 24 * 60 * 60 * 1000);

  if (opts.replacingSessionId) {
    await revokeSession(opts.replacingSessionId);
  }

  const [row] = await db
    .insert(userSessions)
    .values({
      user_id: user.id,
      refresh_token_hash: tokenHash,
      user_agent: opts.userAgent ?? null,
      ip_address: opts.ipAddress ?? null,
      expires_at: expiresAt,
    })
    .returning({ id: userSessions.id, expires_at: userSessions.expires_at });
  if (!row) throw new Error('Failed to create refresh session');
  return { rawToken, sessionId: row.id, expiresAt: row.expires_at };
}

/** Revoke (invalidate) a session row. */
export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ revoked_at: new Date() })
    .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revoked_at)));
}

/**
 * Verify a refresh token: look up the session by token hash and check it is
 * active (not revoked, not expired, user still exists and is active).
 * Returns the session row + user. Throws AuthError('invalid_refresh_token') otherwise.
 */
export async function verifyRefreshToken(rawToken: string): Promise<{
  session: typeof userSessions.$inferSelect;
  user: typeof users.$inferSelect;
}> {
  const hash = hashRefreshToken(rawToken);
  const [session] = await db
    .select()
    .from(userSessions)
    .where(eq(userSessions.refresh_token_hash, hash));
  if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) {
    throw authErr('invalid_refresh_token', 'Invalid or expired refresh token');
  }
  const [user] = await db.select().from(users).where(eq(users.id, session.user_id));
  if (!user || !user.is_active) {
    throw authErr('invalid_refresh_token', 'Account is disabled or missing');
  }
  return { session, user };
}

/** Mark a session as used (for introspection/tracking). */
export async function touchSession(sessionId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ last_used_at: new Date() })
    .where(eq(userSessions.id, sessionId));
}

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'invalid_refresh_token'
  | 'invalid_api_key'
  | 'insufficient_scope'
  | 'missing_credentials';

export class AuthError extends Error {
  code: AuthErrorCode;
  statusCode: number;
  constructor(code: AuthErrorCode, message: string, statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function authErr(code: AuthErrorCode, message: string, statusCode?: number): AuthError {
  return new AuthError(code, message, statusCode);
}