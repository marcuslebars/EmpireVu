#!/usr/bin/env bash
# Starts the e2e stack in the background (logs + pids in $E2E_ROOT):
#   Postgres (setup-db.sh, fresh database) · PostgREST · fakes.mjs · gateway.mjs · Vite dev · Next dev
# Everything except Vite runs under libfaketime reading $E2E_CLOCK_FILE (PostgREST is a static
# binary, so it stays on real time — tokens are minted with a backdated iat to suit both).
# Usage: scripts/e2e-dfy/start.sh   (then: npx tsx scripts/e2e-dfy/run.ts; scripts/e2e-dfy/stop.sh)
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/e2e-dfy/env.sh
mkdir -p "$E2E_ROOT" "$E2E_SHOTS"
scripts/e2e-dfy/stop.sh >/dev/null 2>&1 || true
: > "$E2E_CAPTURE_LOG"

# Start at 09:05 Toronto time on the real date (owner texts only go 08:00–21:00 local).
node -e '
const now = Date.now();
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).formatToParts(now).map(p=>[p.type,p.value]));
const minutesNow = Number(parts.hour)%24*60 + Number(parts.minute);
let offset = 9*60 + 5 - minutesNow; if (offset < -60) offset += 24*60;
require("fs").writeFileSync(process.env.E2E_CLOCK_FILE, (offset>=0?"+":"") + offset + "m\n");
console.log("fake clock offset", offset, "minutes");'

NODE_OPTIONS= scripts/e2e-dfy/setup-db.sh

start() { # name, command...
  local name=$1; shift
  nohup env "$@" >"$E2E_ROOT/$name.log" 2>&1 &
  echo $! >"$E2E_ROOT/$name.pid"
}

cat >"$E2E_ROOT/postgrest.conf" <<EOF
db-uri = "postgres://authenticator@/$E2E_DB?host=$E2E_PGSOCK&port=$E2E_PGPORT"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$E2E_JWT_SECRET"
server-host = "127.0.0.1"
server-port = $E2E_POSTGREST_PORT
db-pool = 20
EOF
start postgrest $FAKETIME_ENV NODE_OPTIONS= "$E2E_POSTGREST_BIN" "$E2E_ROOT/postgrest.conf"
start fakes $FAKETIME_ENV NODE_OPTIONS= node scripts/e2e-dfy/fakes.mjs
start gateway $FAKETIME_ENV NODE_OPTIONS= node scripts/e2e-dfy/gateway.mjs
start vite NODE_OPTIONS= npx vite --port "$E2E_VITE_PORT" --strictPort --host 127.0.0.1
start next $FAKETIME_ENV npx next dev -p "$E2E_NEXT_PORT" -H 127.0.0.1

wait_for() { # name url
  for _ in $(seq 1 120); do
    curl -fsS -o /dev/null "$2" 2>/dev/null && { echo "  $1 up"; return 0; }
    sleep 1
  done
  echo "  $1 did not come up — see $E2E_ROOT/$1.log" >&2; return 1
}
wait_for postgrest "http://127.0.0.1:$E2E_POSTGREST_PORT/"
wait_for fakes "http://127.0.0.1:$E2E_FAKES_PORT/__health"
wait_for vite "http://127.0.0.1:$E2E_VITE_PORT/"
wait_for next "http://127.0.0.1:$E2E_NEXT_PORT/api/health"
wait_for gateway "http://127.0.0.1:$E2E_GATEWAY_PORT/rest/v1/"
echo "e2e stack up: app $CRANKLEADS_APP_BASE_URL (buyer host), $APP_BASE_URL (house host)"
