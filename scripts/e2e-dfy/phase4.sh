#!/usr/bin/env bash
# Phase 4 — Receipts & HST, Service plans, Compliance, Purchasing (+ the Office manager's heads-ups)
# end to end (scripts/e2e-dfy/README.md → "Phase 4"). Fresh stack (start.sh) on its own ports /
# data dirs (567xx, /var/tmp/e2e-p4 …) so it never clashes with another stack, then the driver.
#   scripts/e2e-dfy/phase4.sh                     # start + run (exit 0 = all pass); re-runnable
#   E2E_SKIP_START=1 scripts/e2e-dfy/phase4.sh    # re-run the driver only (needs a fresh DB to pass)
#   E2E_STOP=1 scripts/e2e-dfy/phase4.sh          # stop the stack afterwards
set -euo pipefail
cd "$(dirname "$0")/../.."
export E2E_PGPORT="${E2E_PGPORT:-56734}"
export E2E_POSTGREST_PORT="${E2E_POSTGREST_PORT:-${E2E_PGRSTPORT:-56735}}"
export E2E_FAKES_PORT="${E2E_FAKES_PORT:-56736}"
export E2E_VITE_PORT="${E2E_VITE_PORT:-56737}"
export E2E_NEXT_PORT="${E2E_NEXT_PORT:-56738}"
export E2E_GATEWAY_PORT="${E2E_GATEWAY_PORT:-56739}"
export E2E_ROOT="${E2E_ROOT:-/var/tmp/e2e-p4}"
export E2E_PGDATA="${E2E_PGDATA:-/var/tmp/e2epg-p4/data}"
export E2E_PGSOCK="${E2E_PGSOCK:-/var/tmp/e2esock-p4}"
export E2E_CLOCK_FILE="${E2E_CLOCK_FILE:-/var/tmp/e2e-faketime-p4}"
export SMS_AGENT_COALESCE_MS=200
# Service plans pay through the invoice Checkout on the company's Stripe Connect account: the SDK's
# https calls go to the fake Stripe (intercept.cjs), and the Connect webhook has its own secret.
export E2E_FAKE_STRIPE=1
export STRIPE_CONNECT_WEBHOOK_SECRET="${STRIPE_CONNECT_WEBHOOK_SECRET:-whsec_e2e_connect_fake}"
getent hosts app.crankleads.localhost >/dev/null || { echo "add: 127.0.0.1 app.crankleads.localhost  to /etc/hosts" >&2; exit 1; }
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
  # A re-run starts clean: the storage stub's files and the old capture log go with the old database.
  rm -rf "$E2E_ROOT/storage"
  scripts/e2e-dfy/start.sh
fi
source scripts/e2e-dfy/env.sh
status=0
env $FAKETIME_ENV npx tsx scripts/e2e-dfy/phase4.ts || status=$?
[ "${E2E_STOP:-0}" = 1 ] && scripts/e2e-dfy/stop.sh
exit $status
