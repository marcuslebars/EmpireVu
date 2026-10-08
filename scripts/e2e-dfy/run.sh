#!/usr/bin/env bash
# One command: start the stack (fresh database, fake clock at 09:05 Toronto), run the buyer
# flow driver, leave the stack running for inspection (scripts/e2e-dfy/stop.sh stops it).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ "${E2E_SKIP_START:-0}" = 1 ] || scripts/e2e-dfy/start.sh
source scripts/e2e-dfy/env.sh
getent hosts app.crankleads.localhost >/dev/null || { echo "add: 127.0.0.1 app.crankleads.localhost  to /etc/hosts" >&2; exit 1; }
exec env $FAKETIME_ENV npx tsx scripts/e2e-dfy/run.ts
