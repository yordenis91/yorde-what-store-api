# Yorde What Store — API

![CI](https://github.com/yordenis91/yorde-what-store-api/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma&logoColor=white)
![License](https://img.shields.io/badge/license-proprietary-lightgrey)

Multi-tenant ecommerce SaaS API. A single deployment serves an unbounded
number of independent stores — each tenant gets its own catalog, orders,
customers, staff, checkout configuration, and branding — with tenant
isolation enforced at the database layer via PostgreSQL Row Level Security,
not just application-level filtering.

Pairs with the [`yorde-what-store-client`](https://github.com/yordenis91/yorde-what-store-client)
frontend (React/Vite), which consumes this API for the storefront, the
tenant admin panel, and the Super Admin platform console.

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
  - [Multi-tenancy & Row Level Security](#multi-tenancy--row-level-security)
  - [Auth model](#auth-model)
  - [Background jobs](#background-jobs)
  - [API documentation](#api-documentation)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [npm scripts](#npm-scripts)
- [Testing](#testing)
- [Deployment](#deployment)
- [License](#license)

---

## Features

**Storefront & core commerce**
- Product catalog with categories, taxes, variants, multiple images, and
  platform-curated category templates a new store can seed from.
- Cart-free, server-priced checkout: every total (subtotal, tax, shipping,
  discount) is computed server-side from a quote, never trusted from the
  client.
- Coupons, pickup locations, and per-location shipping rates.
- Storefront customer accounts, separate from staff/owner accounts, with
  their own JWT secrets and password-reset flow.
- Order lifecycle management with a live Server-Sent Events stream for the
  admin dashboard, and PDF invoice generation.
- Per-tenant customizable transactional email templates, with platform-wide
  defaults as a fallback.
- Link-preview (Open Graph) server-rendering for storefront links shared on
  WhatsApp/Telegram/Facebook.

**Tenant administration**
- Staff management with role-based access (`OWNER` / `STAFF`) and email
  invitations.
- Encrypted-at-rest payment gateway credentials (Stripe, MercadoPago) and
  optional per-tenant SMTP configuration.
- Sales/orders dashboard with date-range analytics.

**Super Admin platform**
- Tenant lifecycle management: activate/suspend with a reason trail,
  internal notes, and full status history.
- **Impersonation** — a SUPER_ADMIN can act as a tenant's owner via a
  short-lived, non-renewable token, independently logged.
- Cross-tenant product moderation (search and deactivate a listing that
  violates policy, without touching the tenant's own catalog data).
- Platform-wide audit trail: every sensitive admin action, tenant or
  platform level, is logged with actor, action, entity, and request
  metadata (secrets redacted).
- Platform-wide business settings (default commission rate, fallback SMTP)
  editable at runtime, no redeploy required.
- Subscription plans, upgrade requests, and platform-wide KPIs (GMV,
  commissions, MRR, top tenants).
- Scheduled, off-box Postgres backups to any S3-compatible bucket, with
  retention pruning and a restore path to prove backups are actually
  usable.

**Payments & notifications**
- Pluggable payment adapters (Stripe, MercadoPago) behind a common
  interface, with webhook signature verification.
- WhatsApp/Telegram checkout as first-class fulfillment methods.
- Background email, invoice PDF, inventory sync, and order notification
  processing via Redis-backed queues — nothing blocks the request path.

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22 |
| Framework | [NestJS](https://nestjs.com/) 10 |
| Language | TypeScript 5 |
| Database | PostgreSQL, via [Prisma](https://www.prisma.io/) 5 |
| Cache / queues | Redis, via [BullMQ](https://docs.bullmq.io/) |
| Auth | JWT (access + rotating refresh), TOTP 2FA (`otplib`) |
| Payments | Stripe, MercadoPago |
| Storage | Local disk (product images), S3-compatible (backups) |
| Logging | Winston (structured JSON) |
| API docs | OpenAPI/Swagger |
| Testing | Jest (unit + e2e against real Postgres) |

## Architecture

### Multi-tenancy & Row Level Security

Tenant isolation is enforced by PostgreSQL itself, not just by `WHERE`
clauses an application developer could forget to write.

1. **`TenantMiddleware`** resolves the active tenant on every request, in
   order: the `X-Tenant-ID` header (UUID or slug), a `tenantId` query
   param (for `EventSource`/SSE clients, which can't set headers), or the
   subdomain of the `Host` header.
2. **`TenantScopeInterceptor`** (global) wraps the rest of the request in a
   single Postgres transaction and runs `SELECT set_config('app.tenant_id', ...)`
   for it, storing that transaction's client in an `AsyncLocalStorage`.
3. Every tenant-owned table (`products`, `orders`, `customers`, `coupons`,
   `visits`, ...) has a Postgres RLS policy — `ENABLE` **and**
   `FORCE ROW LEVEL SECURITY` — checking
   `tenant_id = current_setting('app.tenant_id')::uuid`. A query that
   somehow escaped the application's own filtering still cannot return
   another tenant's rows; the failure mode is zero rows or a permission
   error, never a data leak.
4. Platform-level tables with no tenant concept (`users`, `tenants`,
   `plans`, `platform_settings`, `category_templates`, ...) carry no
   `tenant_id` and no RLS — they're authorized purely by `RolesGuard`
   (`SUPER_ADMIN` / `OWNER` / `STAFF`).
5. Cross-tenant reads for the Super Admin platform (dashboards, product
   moderation, backups) go through `PrismaService.withRlsBypass()`, which
   sets `app.bypass_rls = 'on'` for that transaction instead of a tenant id.
   Background job processors, which run outside any request/interceptor,
   use `PrismaService.withTenant(tenantId, work)` to open their own scoped
   transaction.

This isn't just designed-in — it's tested against a real database (see
[Testing](#testing)), including a real production bug this suite caught
before it shipped.

### Auth model

- **Staff/owner** (`auth` module): email+password login, short-lived access
  token (15m) + long-lived rotating refresh token (30d, stored hashed,
  revocable), optional TOTP 2FA. `User.globalRole` carries the
  platform-wide `SUPER_ADMIN` role; `TenantMember.role` carries per-tenant
  `OWNER`/`STAFF`. A user can belong to multiple tenants and switch between
  them.
- **Customer/storefront** (`customers` module): entirely separate JWT
  secrets from staff auth, so a leaked customer token can never be replayed
  against an admin route.
- **Impersonation**: a SUPER_ADMIN can issue a 30-minute, non-renewable
  token authenticating as a tenant's owner, with the acting admin's id
  embedded in the token payload and logged independently to
  `TenantImpersonationLog` and the platform audit trail.

### Background jobs

Redis-backed BullMQ queues, so nothing here blocks a request:

| Queue | Processor | Does what |
| --- | --- | --- |
| `email` | `EmailProcessor` | Transactional email (password reset, staff invite, receipts). Resolves per-tenant SMTP → platform fallback SMTP → logs instead of sending if neither is configured. |
| `invoice-pdf` | `InvoicePdfProcessor` | Renders a PDF invoice for a confirmed order. |
| `inventory-sync` | `InventorySyncProcessor` | Decrements product/variant stock off the request path once an order is confirmed. |
| `order-notification` | `OrderNotificationProcessor` | Sends a Telegram message to the tenant's configured chat on new orders. |
| `visits-cleanup` | `VisitsCleanupProcessor` | Purges storefront visit-tracking rows older than 60 days, across every tenant. |

### API documentation

Interactive OpenAPI/Swagger docs are served at **`/api/v1/docs`** once the
server is running (bearer auth + the `X-Tenant-ID` header are wired into the
"Authorize" dialog).

## Project structure

```
src/
├── modules/
│   ├── products/              Catalog: categories, taxes, variants, images
│   ├── orders/                Order lifecycle, pricing, checkout, SSE feed
│   ├── coupons/                Discount coupons
│   ├── locations-shipping/    Pickup locations & shipping rates
│   ├── category-templates/    Platform-curated starter categories
│   ├── dashboard/             Tenant sales/orders analytics
│   ├── visits/                Storefront visit tracking (RLS + auto-purge)
│   ├── uploads/                Image upload (resized to .webp)
│   ├── email-templates/       Per-tenant transactional email templates
│   │
│   ├── tenants/               Tenant CRUD, payment credentials, SMTP config
│   ├── platform/              Super Admin: stats, tenant lifecycle, product moderation
│   ├── platform-settings/     Platform-wide business settings (commission, SMTP)
│   ├── plans/                 Subscription plans & upgrade requests
│   ├── backups/               Scheduled off-box Postgres backups
│   ├── audit/                 Platform-wide audit trail
│   ├── preview/               Server-rendered link-preview (Open Graph)
│   │
│   ├── auth/                  Staff/owner auth, JWT, 2FA
│   ├── customers/             Storefront customer accounts
│   ├── users/                 Tenant staff management
│   │
│   └── payments/              Stripe/MercadoPago adapters, webhooks
│
├── queue/                     BullMQ processors (see Background jobs)
├── common/
│   ├── middleware/            Tenant resolution
│   ├── interceptors/          RLS transaction scoping, response envelope
│   ├── guards/                JWT auth, roles, tenant-required
│   ├── decorators/            @CurrentUser, @CurrentTenant, @Public, @Roles
│   ├── filters/                Global exception → HTTP response mapping
│   └── utils/                  Encryption, CSV, IP anonymization, date buckets
├── prisma/                     PrismaService (RLS helpers), tenant context
└── config/                     Typed env var configuration

prisma/
├── schema.prisma               Database schema
├── migrations/                 Prisma migrations (includes the RLS policies)
└── seed.ts                     Plans, category templates, SUPER_ADMIN seed

test/                           e2e suite (real Postgres — see Testing)
```

## Getting started

### Prerequisites

- Node.js 22
- PostgreSQL (14+)
- Redis
- `pg_dump`/`pg_restore` client tools, only if you'll use scheduled backups

### Install

```bash
npm install
cp .env.example .env      # then fill in the secrets — see below
```

### Database

```bash
npx prisma migrate deploy   # or `npm run prisma:migrate:dev` while iterating on schema.prisma
npm run prisma:seed         # subscription plans, category templates, SUPER_ADMIN account
```

### Run

```bash
npm run start:dev           # watch mode, http://localhost:3000
```

Local Postgres/Redis for development are provided by `docker-compose.yml`
(Postgres on `5433`, Redis on `6380` — nonstandard ports, so this stack
never collides with another project's default instances on the same
machine):

```bash
docker compose up -d
```

## Environment variables

All of these are documented with inline comments in **`.env.example`** —
copy it to `.env` and fill in real secrets before running anything beyond
`npm test`. Grouped by concern:

| Variable | Default | Notes |
| --- | --- | --- |
| **App** | | |
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | |
| `API_PREFIX` | `api/v1` | |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allow-list. **Empty reflects any origin with credentials — set this explicitly in production.** |
| **Database** | | |
| `DATABASE_URL` | — | Required. |
| **Redis** | | |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `localhost` / `6379` / *(empty)* | Cache, throttling storage, and BullMQ. |
| **Rate limiting** | | |
| `THROTTLE_TTL_MS` / `THROTTLE_LIMIT` | `60000` / `120` | Global per-IP ceiling. |
| **JWT (staff/owner)** | | |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | — | Required, no default. |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `30d` | |
| **JWT (customer)** | | |
| `JWT_CUSTOMER_SECRET` / `JWT_CUSTOMER_REFRESH_SECRET` | — | Deliberately separate from staff secrets above. |
| `JWT_CUSTOMER_EXPIRES_IN` / `JWT_CUSTOMER_REFRESH_EXPIRES_IN` | `15m` / `30d` | |
| **2FA** | | |
| `TOTP_ISSUER` | `YWS` | |
| **Encryption** | | |
| `ENCRYPTION_KEY` | falls back to `JWT_SECRET`, then a dev-only literal | Encrypts tenant payment credentials and bot tokens at rest (AES-256-GCM). **Set explicitly in production** — losing or rotating it silently makes existing encrypted data undecryptable. |
| **Stripe** | | |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | — | Optional; checkout fails per-tenant if unset. |
| **MercadoPago** | | |
| `MERCADOPAGO_ACCESS_TOKEN` / `MERCADOPAGO_WEBHOOK_SECRET` | — | Platform-level, used only for webhook verification/lookups — per-tenant checkout credentials live encrypted in the database. |
| **Mail** | | |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `MAIL_FROM` | *(empty)* / `587` / ... / `no-reply@example.com` | Unset `SMTP_HOST` means the email processor logs instead of sending — no error. Read once at first boot only, to seed the platform settings row; after that, the admin-editable database row is authoritative. |
| **Seed** | | |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | — | Used only by `npm run prisma:seed`. |
| **Backups** | | |
| `BACKUP_CRON` / `BACKUP_RETENTION_COUNT` | `0 3 * * *` / `14` | |
| `BACKUP_DATABASE_URL` | — | **Not** the same role as `DATABASE_URL` — needs `BYPASSRLS`, which must never go on the app's own runtime role. See `DEPLOY.md`. |
| `BACKUP_S3_ENDPOINT` / `BACKUP_S3_BUCKET` / `BACKUP_S3_REGION` / `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` / `BACKUP_S3_PREFIX` | ... / ... / `auto` / — / — / `postgres` | Any S3-compatible provider works (written against Cloudflare R2). The whole feature is optional as a group — missing any required piece just disables it with a one-time warning, nothing fails. |
| **Platform** | | |
| `PLATFORM_DEFAULT_COMMISSION_RATE` | `5` | Read once at first boot to seed the platform settings row; the admin-editable database row is authoritative after that. |

## npm scripts

| Script | Does what |
| --- | --- |
| `start:dev` | Run in watch mode. |
| `build` | Compile to `dist/`. |
| `start:prod` | Run the compiled build. |
| `lint` | ESLint with `--fix` (mutates files — for local use). |
| `lint:ci` | ESLint, check-only (what CI runs). |
| `format` | Prettier over `src/`. |
| `test` | Unit suite (no Postgres/Redis — see [Testing](#testing)). |
| `test:cov` | Unit suite with coverage. |
| `test:e2e` | e2e suite against a real Postgres (`TEST_DATABASE_URL`, or CI's service container). |
| `test:e2e:local` | Same, pointed at this repo's `docker-compose.yml` Postgres — see [Testing](#testing) for one-time setup. |
| `prisma:migrate:dev` | Create/apply a migration from `schema.prisma` changes. |
| `prisma:migrate` | Apply pending migrations (`migrate deploy` — what production runs). |
| `prisma:studio` | Prisma's DB browser GUI. |
| `prisma:seed` | Seed plans, category templates, and the SUPER_ADMIN account. |
| `smoke:smtp` | Real-network SMTP smoke test against live credentials (not run in CI). |
| `load:storefront` | `autocannon`-based load test against a running instance. |

## Testing

Two suites, deliberately different in what they trust.

```bash
npm test              # unit suite — no Postgres, no Redis, no network
npm run test:watch
npm run test:cov

npm run test:e2e       # real Postgres + Redis, real HTTP, real RLS
```

### Unit suite (`*.spec.ts`, next to the code they cover)

Runs against hand-built Prisma doubles. Covers the arithmetic and the
branching — deliberately not the SQL, the HTTP layer, or Postgres itself.

| Area | File | Why it is covered |
| --- | --- | --- |
| Line pricing, tax, coupons | `modules/orders/pricing.util.spec.ts` | Where the money is computed. Pins the discount base — a mismatch here once showed customers one total and charged another. |
| Quote/order parity, coupons, stock | `modules/orders/orders.service.spec.ts` | Asserts a quote equals the order it becomes, that stock is taken with a conditional update, and that cancelling credits it back exactly once. |
| Link-preview rendering | `modules/preview/preview.service.spec.ts` | Tenant-controlled text reaches server-rendered HTML, so escaping is a security property, not cosmetics. |
| Payment credential encryption | `common/utils/crypto.util.spec.ts` | Round-trips `encryptSecret`/`decryptSecret`, the AES-256-GCM used for stored payment credentials. |
| Order message templates | `modules/orders/fulfillment/message-renderer.spec.ts` | Placeholder substitution and the `wa.me` URL builder for WhatsApp/Telegram checkout. |
| Audit trail redaction | `modules/audit/interceptors/audit.interceptor.spec.ts` | Secrets (passwords, tokens, nested credential objects) never reach the audit log in plaintext. |

...plus unit coverage for auth, backups, category templates, customers,
email templates, locations/shipping, payments, platform settings, the
Super Admin platform services, products, tenants, uploads, and the email
queue processor — 25 spec files in total, co-located with the code they
test.

### e2e suite (`test/*.e2e-spec.ts`), against a real Postgres

The unit suite proves the app *asks* Postgres to enforce tenant isolation and
stock limits. Only a real database proves Postgres *does*. Setup:

```bash
# Requires a Postgres role that is NOT a superuser — see below for why.
createuser yws_test --pwprompt --no-superuser   # or via psql: CREATE ROLE ... LOGIN PASSWORD '...';
createdb yws_test --owner yws_test

DATABASE_URL="postgresql://yws_test:yws_test@localhost:5432/yws_test?schema=public" \
  npx prisma migrate deploy

npm run test:e2e
```

`.env.test` carries the matching connection string and other test env vars;
`test/setup-env.ts` loads it and pins `connection_limit=1` on `DATABASE_URL`
before the app boots.

#### Local setup (this repo's docker-compose)

This repo's `docker-compose.yml` maps Postgres to host port **5433**, not the
default 5432 (avoids clashing with other projects' Postgres on this machine).
`test/setup-env.ts` falls back to port 5432 (matching CI's service container),
so local runs need `TEST_DATABASE_URL` pointed at 5433 — done for you by
`npm run test:e2e:local`. One-time setup, against the container already
started by `docker compose up`:

```bash
export PGPASSWORD='yws_dev_password'
psql -U yws -h 127.0.0.1 -p 5433 -d postgres -c \
  "CREATE ROLE yws_test LOGIN PASSWORD 'yws_test' NOSUPERUSER;"
psql -U yws -h 127.0.0.1 -p 5433 -d postgres -c "CREATE DATABASE yws_test OWNER yws_test;"
# CREATE DATABASE assigns the DB owner but not the public schema's owner —
# fix both, or `prisma migrate deploy` below fails with a permissions error.
psql -U yws -h 127.0.0.1 -p 5433 -d yws_test -c "ALTER SCHEMA public OWNER TO yws_test;"

DATABASE_URL="postgresql://yws_test:yws_test@127.0.0.1:5433/yws_test?schema=public" \
  npx prisma migrate deploy

npm run test:e2e:local
```

**Why the role must not be a superuser:** Postgres superusers bypass Row Level
Security unconditionally, regardless of policy or `FORCE ROW LEVEL SECURITY`.
A superuser test role would make every isolation test pass whether or not RLS
actually worked — false confidence in exactly the thing being tested. CI's
Postgres service container boots with its default bootstrap user (`postgres`)
rather than `yws_test`, specifically so `yws_test` can be created fresh as a
plain non-superuser role — Postgres refuses to ever `ALTER ROLE ...
NOSUPERUSER` the bootstrap role itself (a hard-coded protection against an
instance ending up with zero superusers), so setting `POSTGRES_USER: yws_test`
and then trying to strip it, which an earlier version of this workflow did,
always fails.

**Why `connection_limit=1` in the test database URL:** it forces every request
in a test to share Prisma's one physical connection, so a bug that only shows
up when one request inherits a *previous* request's leftover Postgres session
state reproduces on every run — not only under production's connection-pool
luck. That is exactly how the bug below was found.

| Area | File |
| --- | --- |
| Tenant isolation over real HTTP (read, write, and "no tenant resolved") | `test/rls.e2e-spec.ts` |
| Stock race: two simultaneous buyers, one unit | `test/stock-concurrency.e2e-spec.ts` |
| Category templates, dashboard, email templates, customer auth, order SSE stream, visit tracking | `test/*.e2e-spec.ts` |

#### A real bug this suite found: `withRlsBypass()` could 500 after a tenant-scoped request

`TenantScopeInterceptor` sets `app.tenant_id` with `SET LOCAL` for one
request's transaction. On `COMMIT`, Postgres does not fully unset a custom GUC
like that — it reverts to the session default, which for a parameter no
session-level `SET` has ever touched is `''` (empty string), not `NULL`. The
next request landing on that same pooled connection then sees
`current_setting('app.tenant_id', true)` return `''`, and casting `''` to
`uuid` raises a hard Postgres error — regardless of the policy's
`OR current_setting('app.bypass_rls', true) = 'on'` clause, since Postgres
does not skip the cast just because the `OR` is already satisfied.

`withRlsBypass()` (every platform-admin cross-tenant read) only ever sets
`app.bypass_rls`; it has no way to clear that leftover value itself. In
production, under a connection pool, this meant the platform panel could
500 unpredictably depending on which connection a request happened to land on
— worse, invisible in dev, where fresh connections are common and pooling
pressure is low.

Fixed in `prisma/migrations/20260816191200_fix_rls_bypass_after_tenant_scope`:
every policy now wraps the setting in
`nullif(current_setting('app.tenant_id', true), '')` before casting, so a
leftover empty string reads as `NULL` — which compares false rather than
raising — and falls through to the bypass check as intended. It cannot leak
data either way: Postgres fails closed (an error, not a silent grant) both
before and after this fix. It's an availability bug, not a confidentiality
one. `test/rls.e2e-spec.ts` reproduces it with a real request sequence and
would fail again if the policy regressed.

### What neither suite covers

- **External services.** Stripe, Telegram, SMTP and BullMQ processors are not
  exercised against anything real — `STRIPE_SECRET_KEY` in `.env.test` is a
  placeholder that only satisfies the SDK's constructor.
- **Load.** The concurrency test proves correctness with two simultaneous
  requests, not behaviour under real traffic — see `npm run load:storefront`
  for that, run manually against a real instance.

### CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request: Prisma client generation, `lint:ci`, `build`, and the unit suite in
one job; the e2e suite (with real Postgres and Redis service containers) in
a second.

## Deployment

See **[`DEPLOY.md`](./DEPLOY.md)** (this repo) for the API service's
Docker image, entrypoint, required persistent volume, and
production-sensitive environment variables. For the full platform —
this API plus the frontend, Postgres, and Redis on EasyPanel — see the
[`yorde-what-store-client`](https://github.com/yordenis91/yorde-what-store-client)
repo's `DEPLOY.md`.

## License

Proprietary — all rights reserved. Not licensed for reuse or redistribution.
