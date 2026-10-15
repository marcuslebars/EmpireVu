#!/usr/bin/env bash
# Phase 3 — Office manager, Customer import, Keep your number, Hiring & payroll, end to end
# (scripts/e2e-dfy/README.md → "Phase 3"). Fresh stack (start.sh) on its own ports / data dirs
# (566xx, /var/tmp/e2e-p3 …) so it never clashes with another stack, then the scenario driver.
#   scripts/e2e-dfy/phase3.sh                     # start + run (exit 0 = all pass); re-runnable
#   E2E_SKIP_START=1 scripts/e2e-dfy/phase3.sh    # re-run the driver only (needs a fresh DB to pass)
#   E2E_STOP=1 scripts/e2e-dfy/phase3.sh          # stop the stack afterwards
set -euo pipefail
cd "$(dirname "$0")/../.."
export E2E_PGPORT="${E2E_PGPORT:-56634}"
export E2E_POSTGREST_PORT="${E2E_POSTGREST_PORT:-${E2E_PGRSTPORT:-56635}}"
export E2E_FAKES_PORT="${E2E_FAKES_PORT:-56636}"
export E2E_VITE_PORT="${E2E_VITE_PORT:-56637}"
export E2E_NEXT_PORT="${E2E_NEXT_PORT:-56638}"
export E2E_GATEWAY_PORT="${E2E_GATEWAY_PORT:-56639}"
export E2E_ROOT="${E2E_ROOT:-/var/tmp/e2e-p3}"
export E2E_PGDATA="${E2E_PGDATA:-/var/tmp/e2epg-p3/data}"
export E2E_PGSOCK="${E2E_PGSOCK:-/var/tmp/e2esock-p3}"
export E2E_CLOCK_FILE="${E2E_CLOCK_FILE:-/var/tmp/e2e-faketime-p3}"
export SMS_AGENT_COALESCE_MS=200
# Keep your number: the account number + PIN are only collected with a key (a fixed test key).
export PORTING_ENCRYPTION_KEY="${PORTING_ENCRYPTION_KEY:-ZTJlLXBoYXNlMy1wb3J0aW5nLWtleS0zMi1ieXRlcyE=}"
getent hosts app.everdoer.localhost >/dev/null || { echo "add: 127.0.0.1 app.everdoer.localhost  to /etc/hosts" >&2; exit 1; }
# A re-run starts clean: the storage stub's files and the old capture log go with the old database.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [ "${E2E_SKIP_START:-0}" != 1 ]; then
  # Stop a previous run first and wait for its ports to free up (Next's server process can
  # outlive its npx parent by a few seconds, and start.sh would then hit EADDRINUSE).
  scripts/e2e-dfy/stop.sh >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    busy=0
    for p in "$E2E_POSTGREST_PORT" "$E2E_FAKES_PORT" "$E2E_VITE_PORT" "$E2E_NEXT_PORT" "$E2E_GATEWAY_PORT"; do port_busy "$p" && busy=1; done
    [ $busy = 0 ] && break
    sleep 1
  done
  rm -rf "$E2E_ROOT/storage"
  scripts/e2e-dfy/start.sh
fi
source scripts/e2e-dfy/env.sh
status=0
env $FAKETIME_ENV npx tsx scripts/e2e-dfy/phase3.ts || status=$?
[ "${E2E_STOP:-0}" = 1 ] && scripts/e2e-dfy/stop.sh
exit $status
