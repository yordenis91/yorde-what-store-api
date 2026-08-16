Fase 1 completada: Backend NestJS funcionando end-to-end
Descarté el scaffold roto (respaldado en backend_legacy_scaffold_bak/) y reconstruí /var/www/html/yorde-what-store/backend desde cero. Resumen de lo entregado:

Infraestructura

docker-compose.yml en la raíz del proyecto levanta Postgres (:5433) y Redis (:6380) aislados de otros proyectos en esta máquina.
Prisma + PostgreSQL, schema normalizado (26 modelos), migración inicial aplicada con Row Level Security real: cada tabla tenant-scoped tiene política tenant_id = current_setting('app.tenant_id'), activada por transacción vía PrismaService.withTenant() / TenantScopeInterceptor. Verificado con un test negativo: un segundo tenant autenticado consulta /products y recibe [] aunque el primero tiene productos.
Winston (logs JSON estructurados), @nestjs/throttler con almacenamiento en Redis, Swagger en /api/v1/docs, filtro global de excepciones, JWT+RolesGuard globales.
Módulos (todos con controller+service+DTO reales, no stubs):

auth: registro (crea User+Tenant+membership OWNER en una transacción), login, refresh rotativo (cookie httpOnly), 2FA TOTP (otplib+QR) para Owner/Staff/SuperAdmin, switch-tenant.
tenants: CRUD de tienda, resolución pública por slug, credenciales de pago cifradas en reposo (AES-256-GCM).
products: categorías/impuestos/variantes/imágenes normalizados (ya no CSV como en Laravel).
orders: cálculo de impuestos/cupones portado de la lógica legacy, y checkout por WhatsApp/Telegram como método de primera clase — probado end-to-end: genera el link wa.me con el mensaje ya renderizado desde la plantilla de la tienda.
payments: PaymentAdapter (Strategy) + StripeAdapter, checkout session, webhook con verificación de firma.
plans/users: planes+suscripciones (con planes sembrados: Free/Pro/Business), staff por tienda.
BullMQ: colas email, invoice-pdf (genera PDF real con pdfkit), inventory-sync, order-notification (envío a Telegram Bot API).
npm run build compila sin errores y el servidor arranca y responde correctamente en pruebas reales (registro → producto → orden WhatsApp → aislamiento entre tenants).
---

## Tests

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

**Why the role must not be a superuser:** Postgres superusers bypass Row Level
Security unconditionally, regardless of policy or `FORCE ROW LEVEL SECURITY`.
A superuser test role would make every isolation test pass whether or not RLS
actually worked — false confidence in exactly the thing being tested. (CI's
Postgres service container starts its user as a superuser by default; the
workflow explicitly strips that with `ALTER ROLE ... NOSUPERUSER` before
running migrations.)

**Why `connection_limit=1` in the test database URL:** it forces every request
in a test to share Prisma's one physical connection, so a bug that only shows
up when one request inherits a *previous* request's leftover Postgres session
state reproduces on every run — not only under production's connection-pool
luck. That is exactly how the bug below was found.

| Area | File |
| --- | --- |
| Tenant isolation over real HTTP (read, write, and "no tenant resolved") | `test/rls.e2e-spec.ts` |
| Stock race: two simultaneous buyers, one unit | `test/stock-concurrency.e2e-spec.ts` |

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
  requests, not behaviour under real traffic.

### Known gap: `npm run lint`

The lint script fails — there is no ESLint configuration in the repo, and the
script also passes `--fix`, which mutates files and so is unsuitable for CI.
CI therefore runs build and tests only. Adding a config is a separate decision.
