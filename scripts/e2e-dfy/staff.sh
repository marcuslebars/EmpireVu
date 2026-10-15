#!/usr/bin/env bash
# Phase 2 — the AI staff, end to end (scripts/e2e-dfy/README.md → "Phase 2 AI staff").
# Fresh stack (start.sh), then the scenario driver (Estimator, Bookkeeper, Dispatcher, Marketer,
# and a house tenant with every role off).
#   scripts/e2e-dfy/staff.sh                     # start + run (exit 0 = all pass)
#   E2E_SKIP_START=1 scripts/e2e-dfy/staff.sh    # re-run the driver (needs a fresh DB to pass)
#   E2E_STAFF_OUT=/dir scripts/e2e-dfy/staff.sh  # where staff-results.json goes
set -euo pipefail
cd "$(dirname "$0")/../.."
export SMS_AGENT_COALESCE_MS=200
[ "${E2E_SKIP_START:-0}" = 1 ] || scripts/e2e-dfy/start.sh
source scripts/e2e-dfy/env.sh
getent hosts app.everdoer.localhost >/dev/null || { echo "add: 127.0.0.1 app.everdoer.localhost  to /etc/hosts" >&2; exit 1; }
exec env $FAKETIME_ENV npx tsx scripts/e2e-dfy/staff.ts
