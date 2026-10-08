# Shared configuration for the done-for-you e2e harness (sourced by the shell scripts).
# Every third-party credential here is fake; every base URL points at this machine.
export E2E_ROOT="${E2E_ROOT:-/var/tmp/e2e-dfy}"
export E2E_PGDATA="${E2E_PGDATA:-/var/tmp/e2epg/data}"
export E2E_PGSOCK="${E2E_PGSOCK:-/var/tmp/e2esock}"
export E2E_PGPORT="${E2E_PGPORT:-55434}"
export E2E_DB="${E2E_DB:-empirevu_e2e}"
export E2E_POSTGREST_PORT="${E2E_POSTGREST_PORT:-55435}"
export E2E_FAKES_PORT="${E2E_FAKES_PORT:-55436}"
export E2E_VITE_PORT="${E2E_VITE_PORT:-55437}"
export E2E_NEXT_PORT="${E2E_NEXT_PORT:-55438}"
export E2E_GATEWAY_PORT="${E2E_GATEWAY_PORT:-55439}"
export E2E_CAPTURE_LOG="${E2E_CAPTURE_LOG:-$E2E_ROOT/captured.jsonl}"
export E2E_SHOTS="${E2E_SHOTS:-$E2E_ROOT/shots}"
export E2E_JWT_SECRET="${E2E_JWT_SECRET:-e2e-dfy-local-secret-0123456789-abcdefghij}"
export E2E_POSTGREST_BIN="${E2E_POSTGREST_BIN:-$(command -v postgrest || echo /var/tmp/pgrst-dl/postgrest)}"

# Fake clock: libfaketime reads this file ("+450m" = 7.5 h ahead) in every process we start
# (Postgres, PostgREST, Next, the driver), so DB defaults, sweeps and quiet hours agree.
export E2E_CLOCK_FILE="${E2E_CLOCK_FILE:-/var/tmp/e2e-faketime}"
FAKETIME_LIB="$(ls /usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1 /usr/lib/*/faketime/libfaketime.so.1 2>/dev/null | head -1 || true)"
export FAKETIME_ENV="LD_PRELOAD=$FAKETIME_LIB FAKETIME_TIMESTAMP_FILE=$E2E_CLOCK_FILE FAKETIME_CACHE_DURATION=1 FAKETIME_DONT_FAKE_MONOTONIC=1"

_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_anon="$(node "$_here/jwt.mjs" anon)"
_service="$(node "$_here/jwt.mjs" service_role)"
GATEWAY="http://127.0.0.1:$E2E_GATEWAY_PORT"

# App env (Next dev + the tsx driver).
export NEXT_PUBLIC_SUPABASE_URL="$GATEWAY"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$_anon"
export SUPABASE_SERVICE_ROLE_KEY="$_service"
export VITE_SUPABASE_URL="$GATEWAY"
export VITE_SUPABASE_PUBLISHABLE_KEY="$_anon"
export VITE_NEXT_SERVER_ORIGIN="http://127.0.0.1:$E2E_NEXT_PORT"
# House app (operator links) vs the CrankLeads host (every buyer link) — two hostnames for the
# same gateway, so a buyer link built on the wrong host is visible in the timeline, and the SPA
# brands app.crankleads.localhost exactly like app.crankleads.com (Chromium resolves *.localhost
# itself; for Node add "127.0.0.1 app.crankleads.localhost" to /etc/hosts — run.sh checks).
export APP_BASE_URL="http://localhost:$E2E_GATEWAY_PORT"
export CRANKLEADS_APP_BASE_URL="http://app.crankleads.localhost:$E2E_GATEWAY_PORT"
export BUSINESS_TIMEZONE="America/Toronto"
# Railway and Supabase run in UTC; so do we (the DB too — see setup-db.sh).
export TZ=UTC
export OWNER_EMAIL="marcus@crankleads.test"
export OPERATOR_EMAILS="marcus@crankleads.test"
export TWILIO_ACCOUNT_SID="ACe2e00000000000000000000000000000"
export TWILIO_AUTH_TOKEN="e2e-twilio-auth-token"
export TWILIO_FROM_NUMBER="+17055550100"
export RESEND_API_KEY="re_e2e_fake"
export OUTBOUND_FROM_EMAIL="hello@crankleads.test"
export GOOGLE_PLACES_API_KEY="e2e-places-key"
export ANTHROPIC_API_KEY="sk-ant-e2e-fake"
export ANTHROPIC_BASE_URL="http://127.0.0.1:$E2E_FAKES_PORT/anthropic"
export RETELL_API_KEY="key_e2e_fake"
export STRIPE_SECRET_KEY="sk_test_e2e_fake"
export STRIPE_WEBHOOK_SECRET="whsec_e2e_fake"
export STRIPE_PRICE_CL_CATCH="price_cl_catch" STRIPE_PRICE_CL_CLOSE="price_cl_close" STRIPE_PRICE_CL_FRONT_DESK="price_cl_fd"
export STRIPE_SETUP_FEE_CL_CATCH="price_setup_catch" STRIPE_SETUP_FEE_CL_CLOSE="price_setup_close" STRIPE_SETUP_FEE_CL_FRONT_DESK="price_setup_fd"
export NEXT_TELEMETRY_DISABLED=1
# Rewrites fetch() to the third-party hosts above (and the buyer's website) to fakes.mjs.
export NODE_OPTIONS="--require $_here/intercept.cjs ${NODE_OPTIONS:-}"
