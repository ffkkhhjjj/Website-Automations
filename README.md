# Local Growth Engine

Autonomous website-sales platform for local US service businesses — starting with
**plumbing** companies. Discovers leads, scores them, builds demo + production
websites, runs compliant outreach, and tracks the full lifecycle to recurring
hosting subscriptions. The owner only steps in to close qualified deals and
approve high-risk exceptions.

> Current milestone: **project scaffold + relational database** (single source of
> truth). Auth, lifecycle state machine, scoring engines, dashboard, configuration
> UI, discovery, outreach, deployment, and billing arrive in later milestones.

## Stack

- **TypeScript** (strict), Node.js ≥ 20
- **PostgreSQL 16** — the database is the single source of truth for all business state
- **Drizzle ORM + drizzle-kit** — typed schema, migration-based
- Docker Compose for local Postgres (or any local Postgres 16)

## Repository layout

```
drizzle/               generated SQL migrations (0000_initial_schema.sql)
src/db/schema.ts       full schema: tables, enums, FKs, indexes, checks
src/db/client.ts       shared pg pool + drizzle client (defaults match docker-compose)
src/db/seed.ts         idempotent seed: system_settings + scoring_versions v1
src/db/verify.ts       schema + seed verification against a live database
docker-compose.yml     local Postgres (later milestones add more services)
```

## Running locally

```bash
cp .env.example .env          # defaults already match docker-compose

docker compose up -d          # Postgres on localhost:5432 (lge/lge/lge)

npm install
npm run db:migrate            # applies drizzle/0000_initial_schema.sql
npm run db:seed               # system_settings + scoring_versions (idempotent)
npm run db:verify             # prints PASS/FAIL for every table/enum/index/check + seed dump
```

Without Docker, run any PostgreSQL 16 (`createdb lge`, role `lge`) and keep
`DATABASE_URL=postgres://lge:lge@localhost:5432/lge` in `.env`.

## Environment variables

All variables are documented in [.env.example](.env.example). Summary:

| Variable | Required locally | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | default provided | Postgres connection string |
| `DATABASE_SSL` / `DATABASE_POOL_MAX` | no | production SSL / pool tuning |
| `PORT`, `NODE_ENV` | no | HTTP server (later brief) |
| `OWNER_EMAIL`, `OWNER_PASSWORD` | for `auth:bootstrap` | single owner account bootstrap |
| `JWT_SECRET` | production | access-token signing secret |
| `JWT_EXPIRES_IN`, `REFRESH_TOKEN_TTL_DAYS` | no | token lifetimes |
| `AUTH_*_RATE_LIMIT_*` | no | per-IP rate limits on auth routes |
| `ENRICHMENT_API_KEY`, `EMAIL_API_KEY`, `DEMO_HOSTING_API_KEY`, `DEPLOYMENT_API_KEY` | no | integration credentials (later briefs) |

Nothing beyond the database is required to run, migrate, seed, and verify today.

## Authentication & authorization (auth module: `src/auth/`)

The platform has **no public signup**. Credentials come from two places:
the single `OWNER` user account, and server-side API keys for service-to-service
calls.

### Bootstrap the owner account
```bash
cp .env.example .env   # set OWNER_EMAIL and OWNER_PASSWORD; generate JWT_SECRET
npm run auth:bootstrap # tsx src/auth/bootstrap-owner.ts
```
- Creates one `OWNER` user from env vars; the password is **bcrypt-hashed
  (12 rounds)**, never stored or logged in plaintext.
- **Idempotent**: if `OWNER_EMAIL` already exists it skips and leaves the
  existing account untouched - bootstrap never resets a password.
- Fails with a clear message (exit 1) if env vars are missing or the password
  is weak (< 12 chars by default; `OWNER_MIN_PASSWORD_LENGTH`).

### How auth works
- `POST /auth/login` (`{email, password}`) -> JWT access token + refresh token.
  Access tokens are short-lived (default 15m, `JWT_EXPIRES_IN`).
- `POST /auth/refresh` (`{refresh_token}`) -> **rotates** the refresh token: the
  old session row is revoked and a new one issued. A replayed refresh token is
  rejected. Only the SHA-256 hash of the refresh token is stored (`user_sessions`).
- `POST /auth/logout` (`{refresh_token}`) -> revokes the session (idempotent 204).
- `GET /auth/me` -> current principal (user or API key); requires a valid
  credential. `GET /auth/health` is public.
- Login and refresh endpoints are rate-limited per IP (defaults in `.env.example`).

### API keys
Server-side keys are created at runtime - no key is generated from env:
- `POST /auth/keys` `{name, scope}` with `Authorization: Bearer <admin-credential>`
  (an `admin` API key, or the owner's access token). Scopes: `read` | `admin`.
- `POST /auth/keys/:id/revoke` deactivates a key immediately.
- The raw key (`lge_...`) is returned **exactly once** at creation; only its
  SHA-256 hash is stored (`api_keys`), so a leaked DB is not a leaked key set.
- Callers pass the key as `Authorization: Bearer lge_<...>`.

### Protected-route semantics
- `401` - missing/invalid/expired credentials (or replay of a rotated token).
- `403` - valid credential but insufficient scope (e.g. `read` key on an
  admin-only route).
- Error bodies are generic (`{error:{code,message}}`); no internals are leaked.
- The owner (role `OWNER`) has full access; API keys are gated by scope.

### Auth audit trail
Every auth event (login success/failure, token refresh, logout, key
create/revoke, bootstrap create/skip) is written to `audit_logs` with
`source='auth'`, the actor type (`USER`/`API`/`SYSTEM`), actor id, action,
entity type/id, and `before`/`after` state where relevant.

### Tests
```bash
npm run db:migrate   # first time (dev DB)
npm test             # vitest run - integration tests against a throwaway DB
```
Tests create a dedicated `lge_auth_test` database (migrations applied once via
`test/global-setup.ts`), then exercise the full stack through Fastify `inject()`:
login success (200 + tokens + hashed session row), wrong password (401),
unauthenticated (401), insufficient API key scope (403), and sufficient scope
(201). `npx tsc --noEmit` must pass as well.

## Requires configuration

- **`DATABASE_URL` (production)** — point at a managed Postgres before deploying.
- **`ENRICHMENT_API_KEY`** — lead/contact enrichment provider (later brief).
- **`EMAIL_API_KEY`** — outreach/follow-up email provider (later brief).
- **`DEMO_HOSTING_API_KEY`** — demo website hosting (later brief).
- **`DEPLOYMENT_API_KEY`** — production website deployment (later brief).

These integrations are intentionally **not faked**: until a real credential is
supplied and the matching provider module exists, the feature is disabled and
its import path stays a swappable interface.

## Database design decisions

- **Enums**: real Postgres `ENUM` types (`pgEnum`), used consistently for every
  lifecycle/status column — `lead_lifecycle_state` (all 22 master-spec states),
  `website_status`, `exception_priority`, message/campaign/onboarding/subscription/
  payment statuses, scoring/template types, and more. Extended later via
  `ALTER TYPE`, never by splitting columns.
- **UUIDs** everywhere (`gen_random_uuid()`), `timestamptz` timestamps.
- **Scores**: `CHECK` constraints enforce 0–100 as a second line of defense
  below the (later) scoring engines; weights live in `scoring_versions`.
- **Provenance**: one `businesses.provenance` JSONB column carries per-field source
  metadata (source + verified_at) instead of a column per field.
- **Money** is integer cents (`amount_cents`, `value_estimate_cents`) — never floats.
  **No raw card data anywhere** by design.
- **Polymorphic tables** (`tasks`, `exceptions`, `audit_logs`) use
  `entity_type`/`entity_id` (text + uuid) so they can reference any entity
  without fabricated FKs; `audit_logs` is append-only and indexed on
  `(entity_type, entity_id)` so every state transition is traceable.
- **Generic indexes** on the query paths later machinery will use (leads by
  lifecycle state, messages by campaign, tasks by status/scheduled_at, events by
  date, exceptions by status/priority).
- **`metrics.dimension_key`**: jsonb can't be a btree unique-constraint column, so
  a deterministic generated column (`dimension::text`, canonical jsonb output)
  backs the required unique `(metric_date, metric_name, dimension)`.
- **`lead_state_history`** records every lifecycle transition, so the state-machine
  brief lands with full audit history, not just a current-state column.

## Schema inventory (27 tables)

`businesses`, `contacts`, `websites`, `website_analyses`, `lead_scores`, `demos`,
`outreach_campaigns`, `outreach_messages`, `followups`, `conversations`,
`conversation_messages`, `sales_opportunities`, `customers`, `customer_onboarding`,
`production_websites`, `website_versions`, `domains`, `subscriptions`, `payments`,
`tasks`, `exceptions`, `audit_logs`, `system_settings`, `scoring_versions`,
`templates`, `metrics`, `lead_state_history`.

## License / status

Private team project. Not yet live — no transactions until billing ships and the
owner enables it. Feature flags (`flags.*`) are seeded off for that reason.