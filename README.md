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

```bash
npm test              # run the suite
npm run test:watch    # re-run on change
npm run test:cov      # with coverage
```

Specs live next to the code they cover (`*.spec.ts`). They run against
hand-built test doubles and need no Postgres, Redis or network — `npm test`
works on a clean checkout after `npm ci && npx prisma generate`.

What is covered:

| Area | File | Why it is covered |
| --- | --- | --- |
| Line pricing, tax, coupons | `modules/orders/pricing.util.spec.ts` | Where the money is computed. Pins the discount base — a mismatch here once showed customers one total and charged another. |
| Quote/order parity, coupons, stock | `modules/orders/orders.service.spec.ts` | Asserts a quote equals the order it becomes, that stock is taken with a conditional update, and that cancelling credits it back exactly once. |
| Link-preview rendering | `modules/preview/preview.service.spec.ts` | Tenant-controlled text reaches server-rendered HTML, so escaping is a security property, not cosmetics. |

### What these tests do not cover

Worth stating plainly, because the gap is where the remaining risk lives:

- **No database.** The Prisma layer is a double. That covers the arithmetic and
  the branching, and deliberately not the SQL. In particular, the conditional
  `UPDATE ... WHERE quantity >= n` that makes stock reservation race-free is
  asserted as "the service issues this query" — proving Postgres enforces it
  under concurrent orders needs a real database and concurrent requests.
- **No HTTP layer.** Controllers, guards, the tenant middleware and Row Level
  Security are untested here. `supertest` is already a dependency and
  `test:e2e` is wired for exactly this, once a test database is available.
- **No external services.** Stripe, Telegram, SMTP and BullMQ are not exercised.

### Known gap: `npm run lint`

The lint script fails — there is no ESLint configuration in the repo, and the
script also passes `--fix`, which mutates files and so is unsuitable for CI.
CI therefore runs build and tests only. Adding a config is a separate decision.
