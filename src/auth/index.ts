/**
 * Auth module public surface.
 * - password: bcrypt hash/verify + strength policy
 * - tokens: JWT access + rotating refresh tokens
 * - keys: scoped API keys (hash at rest, raw returned once)
 * - audit: auth event logging to audit_logs
 * - middleware: Fastify preHandlers (JWT OR API key, scope guard)
 * - client: Fastify app builder + auth routes
 * - bootstrap-owner: env-driven single-owner bootstrap CLI
 */
export * from './password';
export * from './tokens';
export * from './keys';
export * from './audit';
export * from './middleware';
export * from './client';
export * from './config';