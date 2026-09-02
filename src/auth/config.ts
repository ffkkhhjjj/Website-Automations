/**
 * Auth configuration — all values come from env (documented in .env.example).
 * Never hard-code secrets or TTLs in route code.
 */
import 'dotenv/config';

export interface AuthConfig {
  /** Secret used to sign JWT access tokens. Required in production. */
  jwtSecret: string;
  /** Access token TTL as a jsonwebtoken expiresIn string, e.g. '15m'. */
  jwtExpiresIn: string;
  /** Refresh token lifetime in days (session row expiry). */
  refreshTtlDays: number;
  /** Rate limits (requests / window) — tighter on credential-heavy routes. */
  loginRateLimitMax: number;
  loginRateLimitWindow: string;
  refreshRateLimitMax: number;
  refreshRateLimitWindow: string;
  globalRateLimitMax: number;
  /** API key prefix used to identify keys created by our system. */
  apiKeyPrefix: string;
  /** Minimum acceptable password length for owner bootstrap. */
  minPasswordLength: number;
}

const isProd = process.env.NODE_ENV === 'production';

function required(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.trim().length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `Missing required env var ${name}. Set it in .env (see .env.example) before starting auth.`,
  );
}

/** JWT secret: required in production; dev/test get a clearly-marked non-secret fallback. */
function jwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  if (isProd) {
    throw new Error(
      'Missing required env var JWT_SECRET. Generate one with `openssl rand -hex 32` and set it in .env.',
    );
  }
  // Explicitly NOT a secret — marks dev/test deploys; never used in production.
  return 'dev-only-insecure-secret-change-me';
}

export function loadAuthConfig(): AuthConfig {
  return {
    jwtSecret: jwtSecret(),
    jwtExpiresIn: required('JWT_EXPIRES_IN', '15m'),
    refreshTtlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS ?? '30', 10),
    loginRateLimitMax: parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_MAX ?? '10', 10),
    loginRateLimitWindow: process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW ?? '1 minute',
    refreshRateLimitMax: parseInt(process.env.AUTH_REFRESH_RATE_LIMIT_MAX ?? '60', 10),
    refreshRateLimitWindow: process.env.AUTH_REFRESH_RATE_LIMIT_WINDOW ?? '1 minute',
    globalRateLimitMax: parseInt(process.env.AUTH_GLOBAL_RATE_LIMIT_MAX ?? '300', 10),
    apiKeyPrefix: 'lge',
    minPasswordLength: parseInt(process.env.OWNER_MIN_PASSWORD_LENGTH ?? '12', 10),
  };
}