# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Prisma's engines are fetched by its postinstall, and need openssl present.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npm run build

# `npm run prisma:seed` shells out to ts-node, which is a devDependency and so
# absent from the runtime image. Precompiling the seed keeps it runnable in
# production (`npm run prisma:seed:prod`); its only imports are @prisma/client
# and bcrypt, both present at runtime. Emitted outside ./dist because
# `nest build` wipes that directory.
RUN npx tsc prisma/seed.ts \
    --outDir dist-seed \
    --module commonjs \
    --target ES2022 \
    --esModuleInterop \
    --skipLibCheck

# ---- runtime --------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# postgresql-client-17, pinned to match the production Postgres server's
# major version (17.11 on the EasyPanel deploy this image actually runs
# against — docker-compose and CI still run 15/16, but those never call
# pg_dump). Debian's own default repo ships an older client (bookworm
# defaults to 15) — close enough for plain SQL, but pg_dump refuses outright
# to dump a server whose major version is newer than its own: "aborting
# because of server version mismatch". Pulling the exact version from the
# official PGDG apt repo instead of gambling on Debian's is what makes this
# controllable — if production's Postgres major version changes, bump the
# "17" below to match.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
       https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma

# Scripts stay enabled: bcrypt resolves its prebuilt native binding here.
RUN npm ci --omit=dev

# `prisma migrate deploy` runs on every boot, so the CLI has to exist in the
# runtime image. Copying it from the build stage keeps its version pinned to the
# same lockfile entry instead of drifting to whatever npm resolves later.
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-seed ./dist-seed

# Mount a persistent volume here — product images live on local disk and are
# served from /uploads. Without a volume they are lost on every redeploy.
RUN mkdir -p uploads

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
