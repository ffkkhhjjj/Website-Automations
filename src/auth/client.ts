/**
 * Fastify app builder for the auth module.
 *
 * Wires:
 *  - @fastify/rate-limit (global limits + tightened per-route limits on /auth/login
 *    and /auth/refresh)
 *  - dotenv config (loaded here so tests and the server share one path)
 *  - Routes: POST /auth/login, POST /auth/refresh, POST /auth/logout,
 *    POST /auth/keys (API-key creation, admin scope required),
 *    GET /auth/me (authenticated), GET /auth/health (public)
 *
 * `buildAuthApp` is a factory so integration tests get a fresh instance per test
 * without starting a live listener (Fastify `inject` covers the HTTP surface).
 */
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import 'dotenv/config';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import { users } from '../db/schema';
import { loadAuthConfig } from './config';
import { verifyPassword } from './password';
import {
  signAccessToken,
  issueRefreshSession,
  verifyRefreshToken,
  revokeSession,
  authErr,
  AuthError,
} from './tokens';
import { createApiKey, revokeApiKey } from './keys';
import { auditUser, auditSystem, auditApiKey } from './audit';
import {
  authenticatePreHandler,
  requireScopePreHandler,
  credentialsErrorReply,
  readRefreshTokenFromBody,
} from './middleware';

export async function buildAuthApp(overrides?: { config?: ReturnType<typeof loadAuthConfig>; registerRateLimit?: boolean }) {
  const cfg = overrides?.config ?? loadAuthConfig();
  const app = Fastify({ logger: false });

  // --- rate limiting ---------------------------------------------------------
  // Registering with an onReq hook means the URL is available, so we can tighten
  // limits for the credential-heavy routes only. Also lets tests disable it.
  if (overrides?.registerRateLimit !== false) {
    await app.register(rateLimit, {
      global: true,
      max: cfg.globalRateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.ip, // bind to IP; user id isn't known pre-auth
      onExceeded: (req) => {
        req.log.warn({ ip: req.ip, url: req.url }, 'rate limit exceeded');
      },
    });
  }

  // --- error handling for auth routes ---------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AuthError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    // Rate-limit errors have this shape; anything else must not leak internals.
    if (reply.statusCode === 429 || (err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests, try again later' } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  // --- routes ----------------------------------------------------------------

  /**
   * POST /auth/login  {email, password}
   * Success: 200 { access_token, refresh_token, expires_in, user:{id,email,role} }
   */
  app.post('/auth/login', { config: { rateLimit: { max: cfg.loginRateLimitMax, timeWindow: cfg.loginRateLimitWindow } } }, async (req, reply) => {
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'email and password are required' } });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email));
    // Always run a comparison to keep timing roughly uniform even for unknown emails.
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !ok) {
      if (user) {
        void auditUser({
          userId: user.id,
          action: 'auth.login.failed',
          after: { reason: 'wrong_password' },
          metadata: { email, ip: req.ip, user_agent: req.headers['user-agent'] ?? null },
        }).catch(() => undefined);
      } else {
        // Unknown email — no user entity exists; log as SYSTEM with a generic target.
        void auditSystem({
          action: 'auth.login.failed',
          entityType: 'login_attempt',
          entityId: '00000000-0000-0000-0000-000000000000',
          metadata: { email, reason: 'unknown_email', ip: req.ip },
        }).catch(() => undefined);
      }
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'Invalid email or password' } });
    }
    if (!user.is_active) {
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'Account is disabled' } });
    }

    void auditUser({
      userId: user.id,
      action: 'auth.login.success',
      after: { email: user.email, role: user.role },
      metadata: { user_agent: req.headers['user-agent'] ?? null, ip: req.ip },
    }).catch(() => undefined);

    const access_token = signAccessToken({ id: user.id, email: user.email, role: user.role }, cfg);
    const issued = await issueRefreshSession(user, {
      refreshTtlDays: cfg.refreshTtlDays,
      userAgent: req.headers['user-agent'] ?? null,
      ipAddress: req.ip,
    });
    return reply.code(200).send({
      access_token,
      refresh_token: issued.rawToken,
      expires_in: cfg.jwtExpiresIn,
      user: { id: user.id, email: user.email, role: user.role },
    });
  });

  /**
   * POST /auth/refresh  {refresh_token}
   * Rotates the refresh token: old session revoked, new one issued.
   */
  app.post('/auth/refresh', { config: { rateLimit: { max: cfg.refreshRateLimitMax, timeWindow: cfg.refreshRateLimitWindow } } }, async (req, reply) => {
    let rawToken: string;
    try {
      rawToken = readRefreshTokenFromBody(req);
    } catch (e) {
      if (e instanceof AuthError) {
        return reply.code(e.statusCode).send({ error: { code: e.code, message: e.message } });
      }
      return reply.code(401).send({ error: { code: 'invalid_refresh_token', message: 'Invalid refresh token' } });
    }

    let session;
    try {
      session = await verifyRefreshToken(rawToken);
    } catch (e) {
      if (e instanceof AuthError) {
        return reply.code(e.statusCode).send({ error: { code: e.code, message: e.message } });
      }
      return reply.code(401).send({ error: { code: 'invalid_refresh_token', message: 'Invalid refresh token' } });
    }

    const user = session.user;
    void auditUser({
      userId: user.id,
      action: 'auth.token_refreshed',
      entityType: 'user_session',
      entityId: session.session.id,
      metadata: { user_agent: req.headers['user-agent'] ?? null, ip: req.ip },
    }).catch(() => undefined);

    const access_token = signAccessToken({ id: user.id, email: user.email, role: user.role }, cfg);
    const issued = await issueRefreshSession(user, {
      refreshTtlDays: cfg.refreshTtlDays,
      userAgent: req.headers['user-agent'] ?? null,
      ipAddress: req.ip,
      replacingSessionId: session.session.id,
    });
    return reply.code(200).send({
      access_token,
      refresh_token: issued.rawToken,
      expires_in: cfg.jwtExpiresIn,
    });
  });

  /**
   * POST /auth/logout  {refresh_token}
   * Revokes the session; 204 on success (idempotent — unknown tokens still 204).
   */
  app.post('/auth/logout', async (req, reply) => {
    let rawToken: string;
    try {
      rawToken = readRefreshTokenFromBody(req);
    } catch {
      return reply.code(204).send();
    }

    try {
      const { session } = await verifyRefreshToken(rawToken);
      await revokeSession(session.id);
      void auditUser({
        userId: session.user_id,
        action: 'auth.logout',
        entityType: 'user_session',
        entityId: session.id,
      }).catch(() => undefined);
    } catch {
      // already invalid/expired → nothing to revoke; still idempotent success
      return reply.code(204).send();
    }
    return reply.code(204).send();
  });

  /**
   * POST /auth/keys  {name, scope}  — Authorization: Bearer lge_... ADMIN key.
   * Creates an API key; raw key returned exactly once.
   */
  app.post(
    '/auth/keys',
    { preHandler: [authenticatePreHandler(cfg), requireScopePreHandler('admin')] },
    async (req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; scope?: unknown; allowed_resources?: unknown; expires_in_days?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const scope = body.scope === 'read' || body.scope === 'admin' ? body.scope : undefined;
      if (!name || name.length < 3) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: 'name is required (min 3 chars)' } });
      }
      if (!scope) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: 'scope must be "read" or "admin"' } });
      }
      const expiresAt =
        typeof body.expires_in_days === 'number' && body.expires_in_days > 0
          ? new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000)
          : null;

      const created = await createApiKey(cfg, {
        name,
        scope,
        allowedResources: typeof body.allowed_resources === 'string' ? body.allowed_resources : null,
        expiresAt,
      });

      void auditApiKey({
        apiKeyId: req.auth.apiKeyId ?? req.auth.userId ?? 'system',
        action: 'auth.api_key.created',
        entityType: 'api_key',
        entityId: created.id,
        before: null,
        after: { name: created.name, scope: created.scope, expires_at: expiresAt },
      }).catch(() => undefined);

      return reply.code(201).send({
        id: created.id,
        name: created.name,
        scope: created.scope,
        // raw key — the ONLY time it is ever returned
        api_key: created.rawKey,
      });
    },
  );

  /**
   * POST /auth/keys/:id/revoke  — Authorization: Bearer lge_... ADMIN key.
   */
  app.post(
    '/auth/keys/:id/revoke',
    { preHandler: [authenticatePreHandler(cfg), requireScopePreHandler('admin')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return reply.code(400).send({ error: { code: 'invalid_request', message: 'invalid key id' } });
      }
      const res = await revokeApiKey(id);
      void auditApiKey({
        apiKeyId: req.auth.apiKeyId ?? req.auth.userId ?? 'system',
        action: 'auth.api_key.revoked',
        entityType: 'api_key',
        entityId: id,
        before: { active: true },
        after: { active: false },
      }).catch(() => undefined);
      return reply.code(200).send({ revoked: res.ok, id });
    },
  );

  /** GET /auth/me — requires any valid credential (JWT or API key). */
  app.get('/auth/me', { preHandler: [authenticatePreHandler(cfg)] }, async (req, reply) => {
    const p = req.auth;
    if (p.type === 'user') {
      return reply.code(200).send({ type: 'user', user: { id: p.userId, email: p.email, role: 'OWNER' } });
    }
    return reply.code(200).send({ type: 'api_key', api_key: { id: p.apiKeyId, name: p.apiKeyName, scope: p.scope } });
  });

  /** GET /auth/health — public liveness probe (no credentials needed). */
  app.get('/auth/health', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok', service: 'auth' });
  });

  return app;
}