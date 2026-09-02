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
| `SESSION_SECRET` | no | auth (later brief) |
| `ENRICHMENT_API_KEY`, `EMAIL_API_KEY`, `DEMO_HOSTING_API_KEY`, `DEPLOYMENT_API_KEY` | no | integration credentials (later briefs) |

Nothing beyond the database is required to run, migrate, seed, and verify today.

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