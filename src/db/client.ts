import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://lge:lge@localhost:5432/lge';

const pool = new Pool({
  connectionString,
  ...(process.env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
});

// Single shared source of truth for DB access. Later briefs (auth, scoring,
// state machine, dashboard) should import this client and the schema, not
// create their own connections.
export const db = drizzle(pool, { casing: 'snake_case' });
export { pool };