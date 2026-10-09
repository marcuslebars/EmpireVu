#!/usr/bin/env bash
# Phase 1 — the AI front desk, end to end (scripts/e2e-dfy/README.md → "Phase 1 front desk").
# Fresh stack (start.sh) with the front-desk switches on, then the scenario driver.
#   scripts/e2e-dfy/frontdesk.sh                     # start + run (exit 0 = all pass)
#   E2E_SKIP_START=1 scripts/e2e-dfy/frontdesk.sh    # re-run the driver (needs a fresh DB to pass)
#   E2E_FRONTDESK_SHOTS=/dir scripts/e2e-dfy/frontdesk.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
# AI phone answering (voice/ai-answer.ts) + a snappy SMS agent turn for the run.
export RETELL_INTAKE_ENABLED=1
export RETELL_MESSAGE_AGENT_ID="agent_e2e_message"
export RETELL_FUNCTION_SECRET="e2e-retell-fn-secret"
export SMS_AGENT_COALESCE_MS=200
[ "${E2E_SKIP_START:-0}" = 1 ] || scripts/e2e-dfy/start.sh
source scripts/e2e-dfy/env.sh
getent hosts app.crankleads.localhost >/dev/null || { echo "add: 127.0.0.1 app.crankleads.localhost  to /etc/hosts" >&2; exit 1; }
exec env $FAKETIME_ENV npx tsx scripts/e2e-dfy/frontdesk.ts
