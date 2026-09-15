# Despliegue de la API

Esta guía cubre lo específico del servicio de API. La guía completa de la
plataforma (frontend + API + Postgres + Redis en EasyPanel, con el reparto de
dominios y el orden de despliegue) está en el `DEPLOY.md` del repositorio
[`yorde-what-store-client`](https://github.com/yordenis91/yorde-what-store-client).

## Qué trae el repo

| Fichero                | Para qué sirve                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| `Dockerfile`           | Build multi-etapa: compila con devDependencies, ejecuta sin ellas.  |
| `docker-entrypoint.sh` | Aplica migraciones de Prisma y arranca la API.                      |
| `docker-compose.yml`   | Postgres y Redis para desarrollo local. No se usa en producción.    |
| `.dockerignore`        | Mantiene `node_modules`, `dist` y `uploads` fuera del contexto.     |

## Requisitos del servicio

**Puerto:** `3000`
**Healthcheck:** `GET /api/v1/health`
**Build:** Dockerfile

### Volumen persistente (obligatorio)

| Tipo   | Nombre    | Ruta de montaje |
| ------ | --------- | --------------- |
| Volume | `uploads` | `/app/uploads`  |

Las imágenes de producto se escriben en disco local y se sirven como estáticos
desde `/uploads` (`src/main.ts:19`). Sin volumen, **cada redespliegue borra todas
las imágenes de todas las tiendas**.

### Variables de entorno

Todas las de `.env.example`. Tres merecen atención especial en producción:

- **`ENCRYPTION_KEY`** — cifra en reposo las credenciales de pago y los tokens de
  bot de cada tenant (AES-256-GCM). Si no la defines, cae a `JWT_SECRET` y, si
  tampoco existe, a la cadena literal `'insecure-dev-key'`
  (`src/config/index.ts`). Cambiarla o perderla deja esos datos indescifrables:
  genérala una vez con `openssl rand -hex 32` y guárdala en un gestor de
  contraseñas.
- **`CORS_ORIGINS`** — si queda vacía, la API **refleja cualquier origen** con
  credenciales activadas (`src/main.ts:31`). Defínela siempre en producción.
- **`NODE_ENV=production`** — activa el flag `secure` en la cookie de refresh
  (`src/modules/auth/auth.controller.ts:109`), que exige HTTPS.
- **`SMTP_HOST`** — si queda vacía, el worker de correo (`src/queue/processors/email.processor.ts`)
  no falla: registra en el log el asunto y el cuerpo en vez de enviarlo. Cómodo en
  desarrollo, pero en producción significa que invitaciones de staff, confirmaciones
  de pedido y recuperación de contraseña nunca llegan a la bandeja del destinatario
  sin que se note ningún error. Usa el puerto 465 para TLS implícito o 587 para
  STARTTLS (ambos soportados); revisa los logs del worker tras el primer envío real.

## Migraciones

`docker-entrypoint.sh` ejecuta `prisma migrate deploy` en cada arranque. Solo
reproduce migraciones ya generadas y toma un advisory lock de Postgres, así que
es seguro con reinicios. Para desactivarlo (por ejemplo con varias réplicas y un
paso de release separado):

```env
RUN_MIGRATIONS=false
```

## Seed inicial

Crea los planes por defecto (Free/Pro/Business) y la cuenta SUPER_ADMIN a partir
de `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`. En la consola del contenedor:

```bash
npm run prisma:seed:prod
```

`npm run prisma:seed` (sin `:prod`) usa `ts-node`, que es una devDependency y no
existe en la imagen de producción. Por eso el Dockerfile precompila
`prisma/seed.ts` a `dist-seed/prisma/seed.js` (la ruta anidada, no
`dist-seed/seed.js`, es porque el seed importa desde `src/modules/...`, así
que `tsc` calcula la raíz común de ambos como la raíz del repo) y `:prod`
ejecuta esa versión.

## Smoke tests contra servicios externos reales

Los tests unitarios y e2e corren contra dobles/Postgres+Redis locales — nunca
contra Stripe o un SMTP real. Para verificar que las credenciales de
producción realmente funcionan (después de rotarlas, o antes de un deploy que
las toca), hay un smoke test dedicado que no corre en CI porque necesita
salida de red real:

```bash
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=... \
MAIL_FROM=no-reply@tudominio.com SMOKE_TEST_TO=vos@tudominio.com \
npm run smoke:smtp
```

Usa exactamente la misma config de transporte que `EmailProcessor`
(`src/queue/processors/email.processor.ts`), así que un pase acá es señal
directa de que el envío real funciona con esas credenciales. Falla con un
mensaje claro si falta una var, si el host no resuelve, o si la
autenticación es rechazada — no hace falta leer logs de BullMQ para
diagnosticarlo.

Para Stripe no hay script aparte: `stripe.checkout.sessions.create` con una
`STRIPE_SECRET_KEY` inválida ya devuelve un error real y legible del lado de
Stripe (probado manualmente contra la API real durante el desarrollo del
adapter de MercadoPago) — alcanza con crear un checkout de prueba desde el
storefront en modo test.

## Prueba de carga

`scripts/load/storefront-load-test.ts` corre `autocannon` contra la API real
(Postgres/Redis reales, sin mocks) en tres escenarios secuenciales: `/health`
como línea base, `GET /storefront/products` (el path de lectura pública con
más tráfico) y `POST /storefront/orders` (el path de escritura más pesado:
pricing, transacción y RLS en cada query).

```bash
BASE_URL=http://localhost:3000/api/v1 \
TENANT_ID=<uuid-del-tenant> PRODUCT_ID=<uuid-de-un-producto-publicado> \
CONNECTIONS=30 DURATION=20 \
npm run load:storefront
```

El `ThrottlerGuard` global (ver `THROTTLE_LIMIT`/`THROTTLE_TTL_MS` más
arriba) cuenta todo el tráfico del mismo IP contra un único balde, así que
con más de ~120 requests/minuto desde una sola máquina de prueba el 429 dejaría
de medir la API y empezaría a medir el rate limiter. Subí `THROTTLE_LIMIT`
temporalmente al correr este script (nunca en producción).

**Referencia — primera corrida** (2026-09-15, contenedor sandbox compartido,
un solo proceso Node + Postgres/Redis locales; no representa el hardware de
producción, sirve como línea base para detectar regresiones futuras):

| Escenario | req/s | p50 | p95 | p99 | errores |
|---|---|---|---|---|---|
| `GET /health` | 2916 | 9ms | 17ms | 20ms | 0 |
| `GET /storefront/products` | 565 | 51ms | 71ms | 77ms | 0 |
| `POST /storefront/orders` | 347 | 84ms | 109ms | 116ms | 0 |

Sin errores en ningún escenario a 30 conexiones concurrentes. La caída de
throughput de lectura a escritura es esperable (la creación de orden hace
pricing + una transacción con RLS en cada tabla que toca), pero p99 se
mantiene bajo 120ms incluso ahí — no hay indicio de lock contention ni de
que el pool de conexiones de Prisma sea el cuello de botella a esta escala.

## Notas de la imagen

- Base `node:22-slim` en lugar de Alpine: `bcrypt` resuelve su binario nativo
  precompilado para glibc, y Prisma necesita `openssl`, que se instala explícitamente.
- La etapa de runtime instala con `--omit=dev` y luego copia el CLI de Prisma
  desde la etapa de build. Copiarlo en vez de reinstalarlo mantiene su versión
  clavada al mismo lockfile, en lugar de derivar a lo que npm resuelva más tarde.
- Los scripts de instalación se dejan activos a propósito: `bcrypt` los necesita
  para colocar su binding nativo.

## Desarrollo local

```bash
docker compose up -d          # postgres :5433, redis :6380
cp .env.example .env
npm install
npm run prisma:migrate && npm run prisma:seed
npm run start:dev
```

Los puertos están desplazados respecto a los estándar (5433/6380) para no chocar
con otros Postgres o Redis en la misma máquina.
