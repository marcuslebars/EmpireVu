#!/usr/bin/env bash
# Stops what start.sh started (and the e2e Postgres cluster).
cd "$(dirname "$0")/../.."
source scripts/e2e-dfy/env.sh
for name in next vite gateway fakes postgrest; do
  pidfile="$E2E_ROOT/$name.pid"
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  rm -f "$pidfile"
done
pkill -f "next dev -p $E2E_NEXT_PORT" 2>/dev/null || true
pkill -f "vite --port $E2E_VITE_PORT" 2>/dev/null || true
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$PGBIN/pg_ctl" -D "$E2E_PGDATA" stop -m fast >/dev/null 2>&1 || true
else "$PGBIN/pg_ctl" -D "$E2E_PGDATA" stop -m fast >/dev/null 2>&1 || true; fi
echo "e2e stack stopped"
