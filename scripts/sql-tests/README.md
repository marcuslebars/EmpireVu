# SQL privilege tests

Repeatable checks that the database itself refuses writes the app's API would refuse:
billing and plan columns, owner/role changes, quote approval, invoice payments, and so on.
They run against a **throwaway local Postgres**. Never point them at a real Supabase project.

| File | What it does |
| --- | --- |
| `supabase-stubs.sql` | Minimal stand-ins for Supabase platform objects (`anon` / `authenticated` / `service_role`, `auth.uid()` reading the JWT GUCs, `auth.users`, `storage`, the realtime publication, and Supabase's default `GRANT ALL` to the API roles) |
| `run.sh` | Drops and recreates the test database, applies the stubs and every file in `supabase/migrations/` in order, then runs each `*.test.sql` |
| `lock_privileged_columns.test.sql` | Acts as an admin, a member, an owner, `anon` and `service_role` (`set role` plus `request.jwt.claim.sub`) and asserts that each write is refused or allowed |
| `zz_front_desk_hardening.test.sql` | 20261009160000: `owner_phone_e164` is not writable through any session (owner/admin/member/anon), `owner_phone_verified_at` neither; the un-verify trigger; `owner_phone_verifications` is service-role only; the new `notified_to` / `recovery_*` columns aren't client-writable |
| `zz_done_for_you.test.sql` | The done-for-you tables: `setup_intakes` / `company_sites` / `dfy_progress` / `operator_actions` are not client-writable (incl. new columns), the no-login token columns (`setup_intakes.token`, `dfy_progress.forward_token`) are not readable by any client role, anon can't read `company_sites`, the composite (company, org) FKs, and the `updated_at` triggers |
| `postgrest-smoke.mjs` | Sends the same requests a browser would (supabase-js through PostgREST) to a local PostgREST, with signed JWTs |

## Run

```sh
# 1. A throwaway Postgres 16 (any local one works; this is one way)
initdb -D /tmp/pg-test -A trust -U postgres
pg_ctl -D /tmp/pg-test -o "-p 55432 -k /tmp" -l /tmp/pg-test.log start

# 2. Apply all migrations and run the SQL assertions
PGHOST=/tmp PGPORT=55432 PGUSER=postgres scripts/sql-tests/run.sh
#   …prints "ok   denied: …" / "ok   allowed: …" per check, then ALL SQL TESTS PASSED

# 3. (optional) The same through real PostgREST
psql -h /tmp -p 55432 -U postgres -c "create role authenticator login noinherit" \
  -c "grant anon, authenticated, service_role to authenticator"
cat > /tmp/pgrst.conf <<'EOF'
db-uri = "postgres://authenticator@/empirevu_sqltest?host=/tmp&port=55432"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "local-test-secret-local-test-secret-0123"
server-port = 3999
EOF
postgrest /tmp/pgrst.conf &   # https://github.com/PostgREST/postgrest/releases
POSTGREST_URL=http://127.0.0.1:3999 JWT_SECRET=local-test-secret-local-test-secret-0123 \
  node scripts/sql-tests/postgrest-smoke.mjs
```

`run.sh` honours `SQLTEST_DB` (default `empirevu_sqltest`) and the usual `PG*` variables.

## Adding a column the app writes

Client writes are an allowlist of **column grants** (`grant update (col, …) on … to
authenticated`). A new column is not writable through the user's session until a migration
grants it. If a service function that uses the caller's client (`ctx.supabase`) starts
writing a new column, either grant that column (only if a user may set it freely) or write
it with the service-role client. Then add an assertion here.
