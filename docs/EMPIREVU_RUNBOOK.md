# EmpireVu Runbook

> Living document, updated with what the **first production deploy actually required**. All commands are **PowerShell** (Windows). Spoke fan-out (Phase 2) and cutover (Phase 5) are appended as they land.

## Architecture
- One Railway **web service**: Next 14 serves the API (`/api/*`) **and** the built Vite SPA on one origin (cookies / RLS / CORS "just work").
- One **worker service** (to create — not deployed yet): the workflow-event poller.
- **Data**: Supabase/Postgres (external managed; no Railway volume).

## Builder & run — Railway uses **Railpack**, and you MUST pin build + start
⚠️ **The trap we hit (biggest gotcha):** Railpack (Railway's current builder — Nixpacks is deprecated) auto-detects a **static Vite SPA**, builds `dist/`, and serves it via **Caddy** with SPA-fallback. The result is silent and nasty: `GET /` looks fine, but **every `/api/*` route returns the SPA's `index.html`** — the Next server never runs, so the whole API (including `/api/intake`) is dead.

**The fix (committed as `railway.json` at the repo root):**
```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build":  { "builder": "RAILPACK", "buildCommand": "npm run build" },
  "deploy": { "startCommand": "npm run start", "restartPolicyType": "ON_FAILURE" }
}
```
- `buildCommand` = `npm run build` (vite build → copy SPA into `public/` → `next build`).
- `startCommand` = `npm run start` (`next start` — the Node server serving API + SPA, binding Railway's `$PORT`).
- **Confirm after deploy:** the *runtime* logs show **`▲ Next.js … Ready`**, NOT Caddy access lines (`logger":"http.log.access.log0"`). Caddy lines = the override didn't take (check `railway.json` is on `main`).

## Environment variables (web service)
| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `VITE_SUPABASE_URL` | Supabase project URL (server / client-baked) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PUBLISHABLE_KEY` | anon/publishable key (`env.ts` reads `PUBLISHABLE_KEY ?? ANON_KEY`) |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client id (client-baked) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Keep on the web service** — `/api/intake` uses the service role (the one sanctioned exception). *(This corrects an earlier note about moving it to the worker — the intake needs it here.)* |
| `RESEND_API_KEY` | Email (lead notifications) |
| `LEAD_INTAKE_SECRET` | HMAC key for `X-EmpireVu-Signature`; **shared** with the spokes |
| `LEAD_INTAKE_ORG_SLUG` | Org the intake writes to (`a1-group`) |
| `LEAD_NOTIFY_EMAIL` | Lead-notification recipient |
| `LEAD_FROM_EMAIL` | Resend sender (default `leads@a1marinecare.ca`) |
| `PORT` | **Auto-set by Railway — never set manually** |

**Remove (obsolete after consolidation):** `VITE_API_BASE_URL`, `VITE_NEXT_SERVER_ORIGIN` — the SPA is same-origin now; if left set they break the SPA→API calls.

## Fresh Supabase project bootstrap
When pointing the service at a **new** Supabase project:
1. **Apply the full schema** — every file in `supabase/migrations/*.sql`, in order, in the SQL Editor. Assemble them into one paste-ready file:
   ```powershell
   $mig = "C:\Users\marcu\Downloads\syncoree\supabase\migrations"
   $out = "$env:USERPROFILE\Downloads\supabase-full-schema.sql"
   (Get-ChildItem "$mig\*.sql" | Sort-Object Name | ForEach-Object { "-- ===== $($_.Name) =====`r`n" + (Get-Content $_.FullName -Raw) }) -join "`r`n`r`n" | Set-Content -Path $out -Encoding UTF8
   notepad $out
   ```
   Verify: `select count(*) from raw_leads;` returns `0` (a number, not an error).
2. **Repoint the 5 Supabase env vars** (URL + publishable + service_role, client + server) to the new project (Supabase → Project Settings → API). `VITE_*` are baked at build, so set them before the deploy.
3. **Auth**: configure Authentication → Providers (Google) + Site URL/redirect = your Railway domain before CRM login works. *(Not needed for `/api/intake` or for viewing rows in the Supabase Table Editor.)*
4. **No org until Phase 3** — a fresh project has no org, so a valid lead is stored + emailed but flagged "needs attention" with no contact created until `a1-group` is seeded.

## Worker service (to create)
Second Railway service, same repo. Start `npm run worker:workflow-events`. Env: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (+ optional `WORKFLOW_EVENT_WORKER_POLL_MS`/`_BATCH_SIZE`/`_STALE_AFTER_SECONDS`/`_ID`). No volume. Until it runs, workflow jobs queue but don't execute — fine, since intake writes + notifies directly.

## Deploy discipline (auto-deploy on push to `main`)
Every merge to `main` is a production deploy. Gate on the feature branch first (run separately):
```powershell
npm run typecheck
npm run test
npm run build
```
Merge only when all three pass. (Next's build-time typecheck is intentionally off — `npm run typecheck` is the authoritative gate.)

## Post-deploy smoke (PowerShell)
```powershell
$base = "https://syncoree.com"
# 1) SPA serves
(Invoke-WebRequest "$base/" -UseBasicParsing).StatusCode
# 2) API + Supabase env wired: unauth MUST be 401
try { Invoke-RestMethod "$base/api/session/context" | Out-Null; "200 (unexpected)" } catch { $_.Exception.Response.StatusCode.value__ }
```
- `1) → 200` and `2) → 401` = healthy.
- **`2) → 200`** = static/Caddy build (Next isn't running) → fix `railway.json`.
- **`2) → 500`** = Supabase env wrong (URL or publishable key).
- ⚠️ `GET /` = 200 alone is **not** proof — a Caddy static build also 200s at `/`. The `/api/session/context` = 401 check is the real one.

Then run the intake matrix (Phase 2 below).

## Deploy gotchas captured
- **Railpack → static Caddy** (above) — `railway.json` pins build + start. *The* thing to remember.
- **`SUPABASE_SERVICE_ROLE_KEY` stays on the web service** — the intake uses it.
- **Fresh Supabase project** — apply full schema + repoint env + reconfigure auth.
- **Onboarding black screen** — a user with no org hit a bare `<Navigate>` that mounted no `<Routes>`, so nothing rendered. Fixed: `AppBootstrapInner` renders the routes; `OrgProvider` derives the org from the session (commit `52d9956`).
- **`env.ts`** reads `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Middleware** is session-refresh only (no redirects); `/api/*` excluded, so intake is never session-gated. Server-side boundary proven by `src/test/auth-boundary.test.ts`.
- **SPA dir** renamed `src/pages` → `src/screens` (Next reserves `pages/`).

## Backup
All data — including `raw_leads` — lives in Supabase. Rely on Supabase's automated daily backups (Project → Database → Backups); for an extra copy, `pg_dump` the project weekly.

---

## Phase 2 — Lead intake (`POST /api/intake`)
Public HMAC-authed intake for the canonical envelope (`docs/LEAD_SCHEMA.md`). Never drops a lead: `raw_leads` written first, then (best-effort) parsed → contacts/activity/bookings + customer matching + Resend notification.

**Migration:** `20260706120000_add_raw_leads.sql` — included in the full-schema bootstrap above.

**Resend DNS:** `LEAD_FROM_EMAIL`'s domain must be **Verified** in Resend (SPF + DKIM), or intake returns 200 but the email silently never sends. `a1marinecare.ca` is already verified for the legacy hub.

**Smoke test (PowerShell — the secret is read from a session env var you set; it never appears in the script):**
```powershell
# session-only; paste your value:
$env:LEAD_INTAKE_SECRET = '<your secret>'

$base = "https://syncoree.com"
function Send-Intake($body, $sigOverride) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  if ($sigOverride) { $sig = $sigOverride }
  else {
    $h = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($env:LEAD_INTAKE_SECRET))
    $sig = "sha256=" + (($h.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
  }
  try   { $r = Invoke-WebRequest "$base/api/intake" -Method Post -Body $bytes -ContentType "application/json" -Headers @{ "x-empirevu-signature" = $sig } -UseBasicParsing; "STATUS $($r.StatusCode) $($r.Content)" }
  catch { "STATUS $($_.Exception.Response.StatusCode.value__) $(if ($_.ErrorDetails) { $_.ErrorDetails.Message })" }
}
$valid   = '{"schemaVersion":1,"source":"a1marinestorage-contact","sourceSite":"a1marinestorage","formType":"contact","receivedAt":"2026-07-10T12:00:00.000Z","contact":{"name":"Smoke Valid","email":"smoke+valid@example.com"}}'
$garbage = '{"totally":"invalid"}'
"CASE 1 valid ->   " + (Send-Intake $valid   $null)             # expect 200
"CASE 2 bad sig -> " + (Send-Intake $valid   "sha256=deadbeef") # expect 401, no write
"CASE 3 garbage -> " + (Send-Intake $garbage $null)            # expect 200, raw + needs-attention email
```
Verify in Supabase:
```sql
select lead_id, source_site, schema_valid, needs_attention, created_at
from raw_leads order by created_at desc limit 5;
```
Two new rows (CASE 1 `schema_valid=true`, CASE 3 `false`), **none** for CASE 2, and two emails at `LEAD_NOTIFY_EMAIL` (CASE 3 marked "needs attention").

---

_Appended as they land: **Phase 2 spoke fan-out** (Care + Storage dual-send to intake, alongside the legacy hub); **Phase 5** (full end-to-end matrix + cutover criteria to retire the legacy `leads.a1marinecare.ca` hub to fallback)._
