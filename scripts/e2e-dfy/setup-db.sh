#!/usr/bin/env bash
# Throwaway Postgres 16 for the done-for-you end-to-end run (scripts/e2e-dfy/README.md).
# Starts (or restarts) a local cluster under libfaketime so the database clock follows the
# harness clock file, then DROPS and recreates the e2e database: Supabase stubs + every
# migration (the same order scripts/sql-tests/run.sh uses) + e2e-extras.sql.
# Never point this at a real Supabase project.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/e2e-dfy/env.sh

PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
mkdir -p "$E2E_ROOT" "$E2E_PGSOCK"
[ -f "$E2E_CLOCK_FILE" ] || echo "+0" > "$E2E_CLOCK_FILE"
chmod 644 "$E2E_CLOCK_FILE"
chown postgres "$E2E_ROOT" "$E2E_PGSOCK" 2>/dev/null || true

as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

if [ ! -f "$E2E_PGDATA/PG_VERSION" ]; then
  as_pg "$PGBIN/initdb" -D "$E2E_PGDATA" -A trust -U postgres >/dev/null
fi
as_pg "$PGBIN/pg_ctl" -D "$E2E_PGDATA" stop -m fast >/dev/null 2>&1 || true
as_pg env $FAKETIME_ENV "$PGBIN/pg_ctl" -D "$E2E_PGDATA" -o "-p $E2E_PGPORT -k $E2E_PGSOCK" -l "$E2E_ROOT/postgres.log" -w start >/dev/null

export PGHOST="$E2E_PGSOCK" PGPORT="$E2E_PGPORT" PGUSER=postgres
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "drop database if exists \"$E2E_DB\" with (force)" -c "create database \"$E2E_DB\"" \
  -c "alter database \"$E2E_DB\" set timezone = 'UTC'"   # like Supabase
"${PSQL[@]}" -d "$E2E_DB" -f scripts/sql-tests/supabase-stubs.sql
for f in supabase/migrations/*.sql; do
  "${PSQL[@]}" -d "$E2E_DB" -f "$f" >/dev/null || { echo "migration failed: $f" >&2; exit 1; }
done
"${PSQL[@]}" -d "$E2E_DB" -f scripts/e2e-dfy/e2e-extras.sql
echo "e2e database $E2E_DB ready ($(ls supabase/migrations/*.sql | wc -l) migrations) on $E2E_PGSOCK:$E2E_PGPORT"
