#!/usr/bin/env bash
# Applies every migration in supabase/migrations (in filename order) to a THROWAWAY local
# Postgres database, on top of scripts/sql-tests/supabase-stubs.sql, then runs each
# scripts/sql-tests/*.test.sql file. Any failed assertion aborts with a non-zero exit.
#
# Usage:  PGHOST=/path/to/socket-or-host PGPORT=5432 PGUSER=postgres scripts/sql-tests/run.sh
# The target database (default: empirevu_sqltest) is DROPPED and recreated. Never point
# this at a real Supabase project.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${SQLTEST_DB:-empirevu_sqltest}"
export PGUSER="${PGUSER:-postgres}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

"${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\"" -c "create database \"$DB\""
"${PSQL[@]}" -d "$DB" -f scripts/sql-tests/supabase-stubs.sql
for f in supabase/migrations/*.sql; do
  "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null || { echo "migration failed: $f" >&2; exit 1; }
done
echo "applied $(ls supabase/migrations/*.sql | wc -l) migrations"
for t in scripts/sql-tests/*.test.sql; do
  echo "== $t"
  "${PSQL[@]}" -d "$DB" -f "$t"
done
echo "ALL SQL TESTS PASSED"
