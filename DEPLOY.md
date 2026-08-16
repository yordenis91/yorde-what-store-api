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
`prisma/seed.ts` a `dist-seed/seed.js` y `:prod` ejecuta esa versión.

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
