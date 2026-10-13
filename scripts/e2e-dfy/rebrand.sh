#!/usr/bin/env bash
# Everdoer rebrand PR 1 — the compatibility layer end to end (scripts/e2e-dfy/rebrand.ts). Fresh
# stack (start.sh) on its own ports / data dirs (569xx, /var/tmp/e2e-rb …), with the legacy-host
# 301 switched ON and the header / signature secrets set, then the driver.
#   scripts/e2e-dfy/rebrand.sh                    # start + run (exit 0 = all pass)
#   E2E_SKIP_START=1 scripts/e2e-dfy/rebrand.sh   # re-run the driver only (counts accumulate)
#   E2E_STOP=1 scripts/e2e-dfy/rebrand.sh         # stop the stack afterwards
set -euo pipefail
cd "$(dirname "$0")/../.."
export E2E_PGPORT="${E2E_PGPORT:-56934}"
export E2E_POSTGREST_PORT="${E2E_POSTGREST_PORT:-56935}"
export E2E_FAKES_PORT="${E2E_FAKES_PORT:-56936}"
export E2E_VITE_PORT="${E2E_VITE_PORT:-56937}"
export E2E_NEXT_PORT="${E2E_NEXT_PORT:-56938}"
export E2E_GATEWAY_PORT="${E2E_GATEWAY_PORT:-56939}"
export E2E_ROOT="${E2E_ROOT:-/var/tmp/e2e-rb}"
export E2E_PGDATA="${E2E_PGDATA:-/var/tmp/e2epg-rb/data}"
export E2E_PGSOCK="${E2E_PGSOCK:-/var/tmp/e2esock-rb}"
export E2E_CLOCK_FILE="${E2E_CLOCK_FILE:-/var/tmp/e2e-faketime-rb}"
# The switches this run proves (all off in production until the checklist says so).
export EVERDOER_REDIRECT_LEGACY_HOSTS=1
export EVERDOER_APP_BASE_URL="https://app.everdoer.com"
export RETELL_FUNCTION_SECRET="${RETELL_FUNCTION_SECRET:-e2e-retell-function-secret}"
export TELNYX_WEBHOOK_SECRET="${TELNYX_WEBHOOK_SECRET:-e2e-telnyx-secret}"
export LEAD_INTAKE_SECRET="${LEAD_INTAKE_SECRET:-e2e-lead-intake-secret}"
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [ "${E2E_SKIP_START:-0}" != 1 ]; then
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
env $FAKETIME_ENV npx tsx scripts/e2e-dfy/rebrand.ts || status=$?
[ "${E2E_STOP:-0}" = 1 ] && scripts/e2e-dfy/stop.sh
exit $status
