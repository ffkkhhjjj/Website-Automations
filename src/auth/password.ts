/**
 * Password hashing — bcrypt via bcryptjs (pure JS, no native build needed).
 * Always use the async APIs; never store or log plaintext passwords.
 */
import bcrypt from 'bcryptjs';

export const BCRYPT_ROUNDS = 12;

/** Hash a plaintext password. */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** Verify a plaintext password against a bcrypt hash. Never throws on mismatch. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Enforce a minimum password strength for owner bootstrap.
 * Password must be non-empty, at least `minLength` chars, and not all whitespace.
 */
export function assertStrongPassword(plain: string, minLength: number): void {
  const fails: string[] = [];
  if (typeof plain !== 'string' || plain.trim().length === 0) {
    fails.push('must not be empty');
  } else {
    if (plain.length < minLength) fails.push(`must be at least ${minLength} characters`);
    if (/^\s+$/.test(plain)) fails.push('must not be only whitespace');
  }
  if (fails.length > 0) {
    throw new Error(`Password ${fails.join(' and ')}.`);
  }
}