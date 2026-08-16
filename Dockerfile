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
