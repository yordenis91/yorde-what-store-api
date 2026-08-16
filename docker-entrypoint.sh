#!/bin/sh
# Applies pending Prisma migrations, then hands off to the API process.
#
# `migrate deploy` only replays already-generated migration files and takes a
# Postgres advisory lock, so it is safe to run on each boot. Set
# RUN_MIGRATIONS=false to skip it (e.g. when running several replicas and
# migrating from a separate release step).
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] applying database migrations..."
  npx prisma migrate deploy
else
  echo "[entrypoint] RUN_MIGRATIONS=false — skipping migrations"
fi

echo "[entrypoint] starting API on port ${PORT:-3000}"
exec node dist/main
