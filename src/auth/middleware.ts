/**
 * Fastify auth middleware — authenticate requests using EITHER:
 *   - a Bearer JWT access token (owner), or
 *   - a Bearer API key (service-to-service, scope-checked).
 *
 * 401 for missing/invalid credentials, 403 for insufficient scope.
 * Error bodies never leak internal details.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken, verifyRefreshToken, AuthError, authErr } from './tokens';
import { verifyApiKey } from './keys';
import type { AuthConfig } from './config';

export interface AuthPrincipal {
  type: 'user' | 'api_key';
  userId?: string;
  email?: string;
  role?: 'OWNER';
  apiKeyId?: string;
  apiKeyName?: string;
  scope?: 'read' | 'admin';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPrincipal;
  }
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Resolve the caller principal from the Authorization header.
 * Throws AuthError with code 401/403; never throws other exception types.
 */
export async function authenticate(cfg: AuthConfig, rawAuthHeader: string | undefined): Promise<AuthPrincipal> {
  if (!rawAuthHeader) throw authErr('missing_credentials', 'Missing authorization header');

  const m = BEARER_RE.exec(rawAuthHeader);
  if (!m?.[1]) throw authErr('missing_credentials', 'Invalid authorization header format');

  const token = m[1];

  // Fast path: keys carry our prefix (`lge_`).
  if (token.startsWith(`${cfg.apiKeyPrefix}_`)) {
    let row;
    try {
      row = await verifyApiKey(token);
    } catch (e) {
      // normalize any unexpected error into a generic 401 — no internals leaked
      if (e instanceof AuthError) throw e;
      throw authErr('invalid_api_key', 'Invalid API key');
    }
    return { type: 'api_key', apiKeyId: row.id, apiKeyName: row.name, scope: row.scope };
  }

  // Otherwise treat it as a JWT access token.
  let payload;
  try {
    payload = verifyAccessToken(token, cfg);
  } catch {
    throw authErr('invalid_credentials', 'Invalid or expired access token');
  }
  return { type: 'user', userId: payload.sub, email: payload.email, role: payload.role };
}

/**
 * Scope guard: the owner (JWT, role OWNER) has full access; API keys are gated
 * by their scope — 'admin' for admin-only routes, anything for 'read' routes.
 */
export function hasScope(principal: AuthPrincipal, requiredScope: 'read' | 'admin'): boolean {
  if (principal.type === 'user') return true; // owner JWT
  if (requiredScope === 'admin') return principal.scope === 'admin';
  return true; // any API key has at least read scope
}

/**
 * Fastify preHandler: sets request.auth for protected routes.
 * Optionally requires the api key scope (for key-only routes like key creation).
 */
export function authenticatePreHandler(cfg: AuthConfig) {
  return async function preHandler(req: FastifyRequest): Promise<void> {
    try {
      req.auth = await authenticate(
        cfg,
        req.headers.authorization as string | undefined,
      );
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw authErr('invalid_credentials', 'Invalid credentials');
    }
  };
}

/** PreHandler that additionally enforces the required API key scope. */
export function requireScopePreHandler(requiredScope: 'read' | 'admin') {
  return async function scopePreHandler(req: FastifyRequest): Promise<void> {
    if (!hasScope(req.auth, requiredScope)) {
      throw authErr('insufficient_scope', 'Insufficient scope', 403);
    }
  };
}

export function credentialsErrorReply(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof AuthError) {
    return reply.code(e.statusCode).send({ error: { code: e.code, message: e.message } });
  }
  // Generic fallback — no internals.
  return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'Invalid credentials' } });
}

/**
 * Body guard for refresh/logout: pulls the refresh token out of the request body.
 * Throws 401 if absent or not a string.
 */
export function readRefreshTokenFromBody(req: FastifyRequest): string {
  const body = (req.body ?? {}) as { refresh_token?: unknown };
  const raw = typeof body.refresh_token === 'string' ? body.refresh_token : undefined;
  if (!raw || raw.trim().length === 0) {
    throw authErr('invalid_refresh_token', 'Missing refresh token');
  }
  return raw;
}

/** Convenience used by refresh/logout handlers to resolve + rotate safely. */
export async function resolveRefreshSession(rawToken: string): Promise<{
  sessionId: string;
  user: { id: string; email: string; role: 'OWNER' };
}> {
  const { session, user } = await verifyRefreshToken(rawToken);
  return { sessionId: session.id, user: { id: user.id, email: user.email, role: user.role } };
}