import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Local default matches docker-compose.yml. Override with DATABASE_URL from .env.
    url: process.env.DATABASE_URL ?? 'postgres://lge:lge@localhost:5432/lge',
  },
  strict: true,
  verbose: true,
});