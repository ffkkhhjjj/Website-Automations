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

## Owner dashboard (`src/dashboard/` + `src/public/`)

The owner sees the state of the whole business in 30 seconds — no browsing
through every lead. The dashboard is a thin, server-served shell (Option A from
brief 6):
- the **API** (`GET /api/dashboard/overview`, authenticated, JSON) is the
  platform's first-class surface — later automation and mobile clients can
  consume it directly;
- the **page** (`GET /dashboard`) is a dependency-free HTML/CSS/JS client of
  that API that renders stat cards, hot leads, today's activity, exceptions,
  and system health. There is **no build step** — static assets live in
  `src/public/` and are served by `@fastify/static`.

### URLs
| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/dashboard/overview` | owner JWT or any API key (read scope) | full JSON overview |
| `GET /dashboard` | public shell (data only after login) | the 30-second view |
| `GET /dashboard/auth/login` | public | minimal owner login page |
| `GET /dashboard/assets/*` | public | CSS/JS (no business data) |

### How page auth works
The shell itself is public HTML; it holds **no business data**. After login the
owner's **JWT access token** is kept in `localStorage` and sent as
`Authorization: Bearer <token>` to `/api/dashboard/overview`. Logging out
clears the token and returns to the login page. The token is short-lived
(default 15m) and rotates via the normal `POST /auth/refresh` flow. (JWT-in-
localStorage is a deliberate shell-phase tradeoff; a cookie-based session is a
later hardening step if the dashboard grows.)

### What is real vs. not wired — no fake numbers
Every metric is computed from real tables (see `src/dashboard/service.ts`):

| Count | Table / source |
| --- | --- |
| leadsFound / leadsQualified / interested / sales | `businesses.lifecycle_state` |
| demosCreated | `demos` (any status) |
| emailsSent / emailBounces / unsubscribes | `outreach_messages.status` (SENT-family / BOUNCED / OPTED_OUT) |
| replies | `conversation_messages` direction INBOUND |
| systemErrors | open `exceptions` with priority CRITICAL or HIGH |
| todayActivity | today's `audit_logs` + `tasks` (limit 10) |
| exceptions | open (OPEN/ACKNOWLEDGED) `exceptions`, CRITICAL → HIGH → MEDIUM → LOW |
| health | live `SELECT 1` + `tasks` by status + last `audit_logs` timestamp |

**Not wired (returned as honest `0` with `countsMeta` provenance):**
`revenue` (comes from the connected finance account only once money moves —
the platform is not live), `mrr` (billing/subscriptions pipeline), and
`demoViews` (demo-host analytics). The page shows these cards as `0` with a
"source not wired" note — the dashboard never guesses.

**Hot leads**: businesses currently `HOT`, or `INTERESTED` with an inbound
reply in the last 14 days; the top-N are returned by `lead_priority_score`
(N = `notifications.hot_lead_limit`, seeded 10, editable from Settings —
fallback 10). Each card carries business name, city/state, website URL,
priority/quality scores, latest reply snippet, intent classification,
confidence, a human-readable suggested action, and the demo URL.

### Tests
`test/dashboard.test.ts` covers: 401 without credentials; owner JWT + shape of
all payload keys; read-scope API key; seeded HOT business surfaces with every
spec field; CRITICAL exception prioritized first; honest zeros on an empty DB
with `health.dbReachable: true`; and page/asset/login serving (200 + content).

## Lead lifecycle (state machine: `src/lifecycle/`)

Every lead routes through a strictly-enforced state machine — the platform's
deterministic backbone. The machine never silently allows a move: a transition
is legal **iff** it is in `LEAD_TRANSITIONS` (`src/lifecycle/transitions.ts`,
the single source of truth), otherwise `transition()` throws
`InvalidTransitionError`.

### Transition map (summary)

```
DISCOVERED → ENRICHING → ENRICHED → ANALYZING → ANALYZED → QUALIFIED
          → DEMO_GENERATING → DEMO_READY → OUTREACH_PENDING → CONTACTED
          → FOLLOWUP_1 → FOLLOWUP_2 → RESPONDED
RESPONDED → NURTURE | INTERESTED | HOT → SALES_HANDOFF → WON → CUSTOMER
```

The map also includes the recovery/reverse edges an autonomous system needs:
retry edges (DEMO_GENERATING → DEMO_GENERATING, DEMO_READY →
DEMO_GENERATING), back-out edges (SALES_HANDOFF → INTERESTED/HOT/NURTURE,
INTERESTED → NURTURE, HOT → NURTURE), and the terminal exits:

- **REJECTED** — from ENRICHING/ENRICHED/ANALYZING/ANALYZED/QUALIFIED, and
  from DEMO_/OUTREACH_* when a rejection rule fires late.
- **DO_NOT_CONTACT** — from CONTACTED/FOLLOWUP_*/RESPONDED/NURTURE/INTERESTED/
  HOT/SALES_HANDOFF on opt-out or a do-not-contact request.
- **LOST** — from SALES_HANDOFF/INTERESTED/HOT (deal lost).
- **WON → CUSTOMER** — terminal for the lifecycle.

Terminal states (REJECTED, DO_NOT_CONTACT, LOST, CUSTOMER) have **no outgoing
edges**; `WON` only advances to `CUSTOMER`.

### Services

- `transition(businessId, toState, { reason?, actor? })` — validates against the
  map and writes `businesses.lifecycle_state` + a `lead_state_history` row +
  an `audit_logs` row (`action='LEAD_STATE_CHANGED'`) **in one DB transaction**.
  Returns the new state. Throws on illegal moves, unknown businesses, or no-ops.
- `reject(businessId, { reasons[], reason?, actor? })` — records one `rejections`
  row per reason (typed `rejection_reason` enum, JSONB detail), then transitions
  to **REJECTED**, or **DO_NOT_CONTACT** when a reason is `OPT_OUT` /
  `DO_NOT_CONTACT_REQUEST` — same transactional guarantees as `transition`.

### Rejection rules (deterministic, `rejection-rules.ts`)

A pure evaluator `evaluateRejectionRules(attributes, context, config)` returns
the triggered reasons for a business given its current data:

| Rule | Fires when |
| --- | --- |
| `OUTSIDE_ICP` | `icpMatch === false` |
| `INACTIVE_BUSINESS` | `business_status` ∈ configured `inactive_statuses` (CLOSED / PERMANENTLY_CLOSED / TEMPORARILY_CLOSED) |
| `NO_CONTACT_ROUTE` | no verified email/phone on file, or `contactability_score < min_contactability_score` |
| `EXCELLENT_WEBSITE` | classification `EXCELLENT`, or `website_quality_score ≥ excellent_website_min` (90) |
| `LOW_OPPORTUNITY` | `business_opportunity_score < min_opportunity_score` (50) |

Thresholds are **config, not env** — read from `system_settings`
(`scoring.rejection.thresholds`, seeded; conservative master-spec defaults if
the key is missing). The scoring engines arrive in a later brief, so the
evaluator accepts scores/classification as typed inputs and never computes them.

Explicit/manual reasons (`OPT_OUT`, `DO_NOT_CONTACT_REQUEST`, `BAD_DATA`,
`DUPLICATE`, `OTHER`) come from owner/pipeline signals and go through the
rejection service, not this evaluator.

### Extending

- **Add a transition** — edit `LEAD_TRANSITIONS` (the map is typed, so any new
  source state must have an entry), then update the README summary + the
  map/row-count tests in `test/transitions.test.ts`.
- **Add a rejection rule** — add the reason to the `rejection_reason` enum
  (schema + migration), implement it in `evaluateRejectionRules`, and test it
  in `test/rejection-rules.test.ts`.
- **Thresholds** always land in `system_settings`; code only supplies defaults.

## Scoring engines (`src/scoring/`)

Three deterministic engines produce a **0–100 lead priority** per business. The
scoring run is invoked **by the pipeline** and **never mutates lifecycle state
itself** — the orchestrator writes analyses/scores/audit rows only; transitions
stay the state machine's job.

### What is deterministic

- **Website technical checks** (`website-checks.ts`) — 12 checks parse the
  observed crawl input (HTTPS, HTTP 2xx, mobile viewport, title, meta
  description, single H1, CTA, contact route, NAP consistency, internal links,
  no broken links, page-speed proxy). Every check emits its own **evidence**
  (observed URL, snippet, status code, timing); a check that cannot run from the
  data returns `NOT_RUN`, never a fabricated pass/fail.
- **Business opportunity signals** (`business-opportunity.ts`) — category scores
  derive only from real provided signals (status, NAP, reviews, services,
  contactability, industry/state vs target config). Absent signals are scored
  conservatively and recorded as "not observed" — the engine never invents
  revenue, employee counts, age, or licenses.
- **Lead priority formula** (`lead-priority.ts`) — `(100 − WSQ) × 0.45 + BOS ×
  0.40 + market_fit × 0.15`, inputs clamped to 0–100, market-fit defaulting to
  the BOS `icp_fit` category.

### What is AI-ready-swappable

The five **subjective** website categories — clarity, copy quality, visual
quality, trust presentation, conversion quality — are evaluated through the
`AiSubjectiveEvaluator` interface (`subjective.ts`), never by hard-coded
guesswork in the technical path. The shipped **`DeterministicFallbackEvaluator`**
derives the same categories from objective signals with a fixed, documented
mapping (same inputs → same outputs), so the pipeline is fully functional today
with zero AI. A real AI evaluator is a later **drop-in behind the same
interface** and is **requires-configuration**: it is only used when
`ai.evaluator.provider/model/prompt` (Settings) *and* the `AI_EVALUATOR_API_*`
env credentials are present (see `.env.example`) — no fake integration.

### Classification bands

| Score | Website quality (`website_classification`) | Lead priority (`lead_classification`) |
| --- | --- | --- |
| 80+ / ≥90 | EXCELLENT (≥90) | HIGH_PRIORITY (≥80) |
| 65–79 / 75–89 | GOOD (≥75) | SECONDARY (≥65) |
| 50–64 / 60–74 | AVERAGE (≥60) | REVIEW (≥50) |
| 40–59 | WEAK (≥40) | — |
| <40 | VERY_WEAK | REJECT (<50) |

`NO_WEBSITE` → WSQ **0** with classification `NO_WEBSITE` (no site observed).
Website bands are fixed by the spec; lead thresholds are configurable in
`system_settings`.

### Versioning

Weights/thresholds live in `system_settings` (owner-editable) with `scoring_versions`
as the immutable, versioned weight snapshots. Every analysis references the
**active `scoring_versions` row by FK** (`analysis_version` on
`website_analyses`, `scoring_version` on `lead_scores`), and each `lead_scores`
row snapshots the formula inputs/weights/thresholds inside `formula_fields` —
so re-scoring keeps full history and later weight changes never rewrite old rows.

### Orchestrator

`scoreBusiness(businessId, opts)` (`orchestrator.ts`) is the only entry point
that runs scoring end-to-end: it loads the business + websites, runs the
engines (a business with no website gets WSQ 0 / `NO_WEBSITE`), then persists —
in **one transaction** — a `website_analyses` row per analyzed website, **one
`lead_scores` row per run**, and `audit_logs` entries (`WEBSITE_ANALYZED` /
`LEAD_SCORED`, `source='scoring'`). Lifecycle state is untouched.

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

## Schema inventory (31 tables)

`users`, `user_sessions`, `api_keys` (auth, migration 0001), then `businesses`,
`contacts`, `websites`, `website_analyses`, `lead_scores`, `demos`,
`outreach_campaigns`, `outreach_messages`, `followups`, `conversations`,
`conversation_messages`, `sales_opportunities`, `customers`,
`customer_onboarding`, `production_websites`, `website_versions`, `domains`,
`subscriptions`, `payments`, `tasks`, `exceptions`, `audit_logs`,
`system_settings`, `scoring_versions`, `templates`, `metrics`,
`lead_state_history`, `rejections` (0002).

## License / status

Private team project. Not yet live — no transactions until billing ships and the
owner enables it. Feature flags (`flags.*`) are seeded off for that reason.