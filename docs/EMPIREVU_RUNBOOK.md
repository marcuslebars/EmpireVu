# EmpireVu Runbook

> Living document, updated with what the **first production deploy actually required**. All commands are **PowerShell** (Windows). Spoke fan-out (Phase 2) and cutover (Phase 5) are appended as they land.

## Architecture
- One Railway **web service**: Next 14 serves the API (`/api/*`) **and** the built Vite SPA on one origin (cookies / RLS / CORS "just work").
- One **worker service** (to create — not deployed yet): the workflow-event poller.
- **Data**: Supabase/Postgres (external managed; no Railway volume).

## CI
`.github/workflows/ci.yml` runs on every PR and on push to `main`: Node 22, `npm ci`, then `npm run typecheck` (SPA), `npm run typecheck:server` (strict), `npm run lint`, `npm run test`, and a gen:types drift check (npm cache on). Any non-zero exit fails the run.
- **`typecheck:server`** compiles `src/server/**`, `src/app/**` and `src/middleware.ts` under `tsconfig.server.json` with `strict` + `noImplicitAny` + `strictNullChecks` on — stricter than the SPA's `tsconfig.app.json`. This is the gate that keeps the server tree fully typed.
- **gen:types drift** runs `npm run gen:types` and fails if `src/server/db/database.types.ts` differs from the committed file. It runs only when `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN` are set as repo secrets (remote mode); a hosted runner can't start a local Supabase, so without them the step is **skipped with a notice**. Set those secrets to enforce type/schema sync.
- **Lint caveat:** the repo had ~2,338 pre-existing lint errors (the `as any` / untyped-table backlog). To make lint a green, blocking gate, `@typescript-eslint/no-explicit-any`, `no-unsafe-function-type`, and `no-empty-object-type` were downgraded **error → warn** in `eslint.config.js`. Task 2 removed the untyped-table `as any` casts from the **server tree** (now strict-clean under `typecheck:server`); the SPA still carries most of the repo's `any`, so ratchet these rules back to `error` only once that backlog clears too.

## Generating database types
`src/server/db/database.types.ts` is generated from the live Postgres schema. Regenerate it after any migration that adds/changes tables, columns, enums, or functions:

```
npm run gen:types
```

`scripts/gen-types.mjs` picks its mode from the environment:
- **remote** — when `SUPABASE_PROJECT_REF` is set (also needs `SUPABASE_ACCESS_TOKEN`): introspects the linked hosted project (`supabase gen types typescript --project-id <ref>`).
- **local** — otherwise: introspects the local dev stack (`supabase gen types typescript --local`); start it first with `supabase start`.

The script prefers a `supabase` on `PATH` and falls back to `npx supabase`, so no global install is required. Commit the regenerated file; the CI drift check (above) keeps it honest once the Supabase secrets are configured.

## Read models (/ui/*)
The dashboard `/ui/*` endpoints read purpose-built SQL views/RPCs (migration `20260903120000_read_models.sql`) instead of loading whole tables into `live-data.ts` and joining in JS. All are `security invoker`, so the caller's RLS applies (no new service-role surface). Naming: `ui_*_v` = view, `ui_*(...)` = function.
- **Summary/list surfaces are wired**: `ui_dashboard_summary`, `ui_automation_impact`, `ui_activity_feed` (keyset primitive), `ui_calendar_bookings`, `ui_contact_list_v`, `ui_task_list_v`, `ui_workflow_list_v`. Search is a trigram `ilike` on `contacts.search_text` (generated).
- **The 1,000-row truncation is fixed everywhere** by the `listAllRows` tourniquet (it now pages), which the **detail** views (contact/booking/task/workflow) still use while their read models (`ui_contact_detail`, `ui_task_detail`, `ui_workflow_detail`) are wired in a follow-up.
- **After applying the migration, run `npm run gen:types`** so the new views/functions are typed (they are hand-written until then), then commit the result.
- **Verify before merge (needs a DB with seed data):** snapshot each `/ui/*` JSON response before vs. after and confirm they match; confirm each call issues ≤ 3 queries. The SQL was authored without a reachable Postgres here, so this verification is the acceptance gate.

## Health check
`GET /api/health` (public, unauthenticated) is Railway's `healthcheckPath` (set in `railway.json`). Returns `{ ok, db, workers: { workflow_events, billing_events, jobber_sync, inbound_webhooks }, version }`:
- `db: "ok"` = an anon `select` reached Postgres; a failed/timed-out probe returns **503** with `db: "error"`.
- `workers.*` report `last_claimed_at` (newest claim timestamp — `locked_at` for the older queues, `claimed_at` for `inbound_webhooks`) and `queued` (`count(status='pending')`) per queue — **aggregate only, never row content**; a stats hiccup degrades these to `null` but keeps a 200 (the DB is up).
- `version` = `RAILWAY_GIT_COMMIT_SHA` (auto-set by Railway; falls back to `"unknown"`). 5-second timeout on both phases.

## Durable-first inbound webhooks
Inbound provider webhooks (Retell, Jobber) are **persisted before they ACK**, so nothing is lost between the `200` and processing (convention: durable-first / never-drop-a-lead). Migration `20260904120000_inbound_webhook_jobs.sql`.
- **`inbound_webhook_jobs`** is one queue for all raw inbound webhooks, modeled on `workflow_event_jobs` (same claim RPC shape: `FOR UPDATE SKIP LOCKED`, stale-lock reclaim, `attempts++`, backoff). `unique (provider, external_id)` makes a redelivery a no-op. RLS is **on with no member policies** — service-role only (webhook routes insert, worker claims).
- **Route flow** (`/api/retell/webhook`, `/api/jobber/webhook`): verify signature → parse → *(Retell only)* upsert the raw payload into `retell_calls` on `call_id` → `INSERT … ON CONFLICT DO NOTHING` into `inbound_webhook_jobs` → **return 200**. No fire-and-forget processing on the request path. `external_id` = Retell `call_id`, or Jobber's event id / a `sha256` of the raw body.
- **Worker** (`workflow-event-worker.ts`, same process/service): each tick it drains `inbound_webhook_jobs` alongside the workflow queue and dispatches by provider back into the **unchanged** handlers — `ingestRetellCall` (identical lead to the old synchronous path) and `handleJobberWebhook`. Success → `completed`; failure → backoff and retry up to `max_attempts` (default 5), then terminal `failed` with `last_error`.
- **Retry a stuck/failed job:** `POST /api/organizations/{organizationId}/inbound-webhook-jobs/{jobId}/retry` (org-membership authz, then a service-role reset scoped to the caller's org or an unresolved null-org job). Mirrors the workflow-event-jobs retry.
- **Ops:** `/api/organizations/{organizationId}/ops/jobs-health` includes `inboundWebhookJobs: { pending, running, failed }`; `/api/health` includes the `inbound_webhooks` worker row.

## Abuse controls on unauthenticated routes
Nobody can use a public form to spam a tenant's CRM or trigger paid outbound AI calls. Migration `20260904140000_abuse_controls.sql`. Three independent layers, all fail-safe:

**1) DB-backed rate limiter (no Redis).** `rate_limit_buckets` + the atomic `consume_rate_limit(key, limit, window_seconds)` (one `insert … on conflict do update`, resets the window when it expires, returns whether still under limit). RLS on, no policies — service-role only, via `src/server/services/rate-limit.ts` → `enforceRateLimit(request, { scope, limit, windowSeconds, keyParts })` returns a ready 429 or null. **Fails open** (a limiter blip never blocks a real user or drops a signed webhook). Keyed on client IP (first `x-forwarded-for` hop) and/or the resource. Applied:
| Route | Limit |
| --- | --- |
| `POST /api/public/booking/[companyId]` | 5 / 10 min per IP **and** 60 / hour per company |
| `GET /api/public/booking/[companyId]` | 60 / 10 min per IP |
| `POST /api/waitlist` | 3 / hour per IP |
| `POST /api/public/quotes/[token]/{approve,reprice}` | 20 / 10 min per token |
| `POST /api/intake`, `/api/retell/*`, `/api/telnyx/*`, `/api/jobber/webhook`, `/api/webhooks/stripe/*` | 600 / min per IP (signed; DoS backstop via `enforceWebhookBackstop`) |

**2) Cloudflare Turnstile + honeypot + timing** on the booking + waitlist forms (`src/server/services/turnstile.ts`). Client renders the widget when `VITE_TURNSTILE_SITE_KEY` is set; the server verifies with `TURNSTILE_SECRET_KEY`. **Fail-open until configured:** unset secret → skip with a warning (every env), so shipping never breaks a live form; once set, a missing/invalid token is rejected. A hidden `website` honeypot and a `formStartedAt` timestamp (submit < 3 s ⇒ bot) run with no network call. ⚠️ The waitlist form lives in the **empirevu-site** repo (empirevu.com); render its widget + post `turnstileToken` there BEFORE setting the shared `TURNSTILE_SECRET_KEY`, or waitlist signups will be rejected. Not applied to the hosted quote page (the token is the auth).

**3) Paid-action guard** (`src/server/services/workflow-engine/guards.ts`). Before a `call_lead` (and later `send_sms`) workflow action runs, `assertPaidActionAllowed` checks whether the trigger was *unauthenticated-sourced* (`activity_event.actor_user_id is null` and `metadata.source ∈ {public_booking, waitlist, intake_unverified}` — signed intake stamps `intake`, which is trusted and exempt). If so it refuses when the same phone (last-10) already got an outbound call from this company in 24 h (`guard:cooldown`), or the company hit its daily cap of unauthenticated-sourced calls (`guard:daily_cap`; default **20**, overridable per org via `feature_flags.limit_value` for feature `public_outbound_calls_daily`). A refusal is recorded as the workflow run's `failure_reason` (logged at *warn*, not as a crash) — visible in Automations. Authenticated triggers pass straight through. Placed calls are tagged (`contact.call_placed` metadata `triggerSource`) so the cap can count them; owner-initiated calls are untagged and never count.

All 429s and guard refusals are logged with org/company ids and **no PII** (no IP, no phone).

## Usage ledger, minutes metering & AI cost controls
Every metered thing is recorded once, rolled up monthly, enforced via `orgLimit`, and shown per tenant. Migration `20260904160000_usage_ledger.sql`.
- **`usage_events`** is the append-only ledger — kinds `voice_minutes`, `sms_sent`/`sms_received`, `email_sent`, `ai_input_tokens`/`ai_output_tokens`/`ai_cache_read_tokens`; each row carries `quantity`, `unit`, `cost_cents`, `provider`, `provider_ref`. `unique (provider, provider_ref, kind)` makes recording **idempotent** (a duplicate webhook / retry counts once). RLS: members read, **no insert policy** — writes go through `services/usage.ts` (service role). `usage_monthly_v` (`security_invoker`) rolls it up by org × company × **month (America/Toronto)** × kind.
- **Written from:** the Retell ingest (`voice_minutes = duration_ms/60000`, `cost_cents` from Retell's `call_cost.combined_cost`, ref = `call_id`; `retell_calls` also stores `duration_ms`/`start_timestamp`/`end_timestamp`/`call_cost_cents`/`cost_breakdown`); customer SMS/email sends (`ai-drafts`, ref = Twilio SID / Resend id); and each Claude call (`ai/claude.ts`, `ai/workflow-author.ts` → tokens from `response.usage`, ref = `response.id`, cost from env-overridable per-MTok rates in `ai/pricing.ts`). All writes are **best-effort** — metering never fails a customer send or an AI call.
- **Limits:** `front_desk.marina_reception = 500` monthly voice minutes (`PLAN_FEATURE_LIMITS`). `orgUsageRemaining` = `orgLimit` − month-to-date usage (`usage_monthly_v`); `requireFeature("marina_reception")` now also throws `UsageCapExceeded` (→ **402** in `handleRoute`) when remaining ≤ 0, covering `/voice/call` and the contact quick-call. The `call_lead` automation is capped via the Task 5 guard (`guard:usage_cap`). **Inbound Marina calls are never refused** — they only record usage; crossing 500 shows as an *overage* in the billing panel (Stripe overage billing is a later task).
- **AI cost controls:** the static system prompt in both Claude call sites is sent as a cached block (`cache_control: ephemeral`); model per surface is env-selectable (`AI_MODEL_DRAFTS`, `AI_MODEL_WORKFLOWS`, default `claude-opus-4-8`) so drafts can move to a smaller model without a deploy.
- **Visibility:** `/settings/billing` shows a **This month** panel (minutes vs cap, SMS, emails, AI cost estimate) via `GET /api/organizations/{id}/usage/monthly` (member RLS). Internal per-tenant **cost vs MRR** is `GET /api/ops/tenant-costs` — token-gated by `OPS_ADMIN_TOKEN` (JSON or `?format=csv`), service-role, cross-tenant; MRR = the tenant's plan list price from Stripe (`listPlanPricing`). *(Delivered as a token-gated endpoint rather than an in-app page — the app has no platform-admin identity; a platform-admin UI can consume it later.)*

## Service-role (sanctioned) surfaces
`createSupabaseAdminClient()` (service role, bypasses RLS) is used only where a request has no forgeable RLS identity, each carrying a `SANCTIONED EXCEPTION` header comment (convention #2): lead-intake, public-booking, telnyx, retell, quotes (public/checkout/connect), billing, jobber, waitlist, invitations, the workers/jobs, **`/api/health`** (aggregate queue counts only), the **rate limiter** (`services/rate-limit.ts`), and now the **usage ledger** (`services/usage.ts` — writes `usage_events`, which has no insert policy) and the **internal cost report** (`/api/ops/tenant-costs` — cross-tenant aggregates, token-gated). `SUPABASE_SERVICE_ROLE_KEY` stays on the web service.

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
| `LEAD_FROM_EMAIL` | Resend sender for **owner notifications** (default `leads@a1marinecare.ca`) |
| `ANTHROPIC_API_KEY` | Claude — lead analysis + drafted replies. **Also required on the worker** (see below) |
| `OUTBOUND_FROM_EMAIL` | Resend sender for **customer-facing** AI replies. Falls back to `LEAD_FROM_EMAIL`, but that reads "EmpireVu Leads" — set a customer-appropriate sender. Domain must be verified in Resend |
| `OUTBOUND_REPLY_TO` | *(optional)* Where a customer's reply lands |
| `TWILIO_ACCOUNT_SID` | SMS — Twilio account SID (`AC…`) |
| `TWILIO_AUTH_TOKEN` | SMS — Twilio auth token |
| `TWILIO_FROM_NUMBER` | SMS — the sending number, E.164 (`+1…`) |
| `BUSINESS_TIMEZONE` | *(optional)* IANA zone the AI reasons about booking times in. Default `America/Toronto` |
| `PORT` | **Auto-set by Railway — never set manually** |

All three `TWILIO_*` vars must be set together — SMS send is disabled (with a clear
error, never a silent no-op) unless all three are present. Same for email:
`RESEND_API_KEY` + a sender. Sending is **draft-first** — a human clicks send — so
these only ever apply to the web service, never the worker.

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

## Worker service
Second Railway service, same repo. Start `npm run worker:workflow-events`. Env: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (+ optional `WORKFLOW_EVENT_WORKER_POLL_MS`/`_BATCH_SIZE`/`_STALE_AFTER_SECONDS`/`_ID`). No volume. Until it runs, workflow jobs queue but don't execute — fine, since intake writes + notifies directly. **The same process also drains `inbound_webhook_jobs`** (Retell/Jobber) each tick — see [Durable-first inbound webhooks](#durable-first-inbound-webhooks) — so once inbound webhooks are live this service must be deployed for calls/events to be processed (they persist safely either way).

### ⚠ `ANTHROPIC_API_KEY` must ALSO be on the worker
Workflow actions execute **in the worker**, so the `ai_analyze` action (the
"Analyze the lead with AI" automation) needs `ANTHROPIC_API_KEY` on the *worker*
service, not just the web one. Without it every live run throws "AI is not
configured".

**This does not show up in testing** — three ways it can look fine and still be dead:
- the Automations **Test** button runs a *dry run*, and `ai_analyze` skips the
  Claude call entirely on a dry run — so Test passes without ever calling Claude;
- **Run now** executes in the *web* service, which has the key — so it passes too;
- the contact AI tab's **Analyze** button is also the web service — passes.

Only a real lead → queued job → worker exercises the worker's copy of the key.
To verify for real: add a contact, let the workflow fire, and confirm the
"Review AI-drafted reply" task appears. If it doesn't, check the worker's logs for
"AI is not configured".

## Deploy discipline (auto-deploy on push to `main`)
Every merge to `main` is a production deploy. Gate on the feature branch first (run separately):
```powershell
npm run typecheck
npm run test
npm run build
```
Merge only when all three pass. (Next's build-time typecheck is intentionally off — `npm run typecheck` is the authoritative gate.)

## Pending migrations to apply to the live Supabase
Railway does **not** run migrations. Apply these in the SQL Editor with (or before)
the deploy that ships them, or the matching writes fail against the live DB.

| Migration | Why | Note |
|---|---|---|
| `20260712000000_add_booking_no_show.sql` | `no_show` was dropped from `booking_status` by the 2026-03-22 harden migration | `alter type public.booking_status add value if not exists 'no_show';` — **ADD VALUE runs outside a transaction**, so run it on its own |
| `20260715000000_add_ai_drafts.sql` | Phase D: the `ai_drafts` table behind the AI review-and-send tab | Plain DDL; paste the file as-is. Verify: `select count(*) from ai_drafts;` returns `0`, not an error |

Until `ai_drafts` exists, the AI tab's Analyze button and the `ai_analyze`
automation both fail on the insert.

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

## Phase D — AI replies to leads (draft-first)

**The rule: nothing reaches a customer without a human click.** There is no
auto-send path in the code — the engine can analyze and draft, but only the
Send button on the contact's **AI** tab actually sends. Owner's decision,
2026-07-15.

The loop:
1. A draft is created — either the **Analyze lead** button on the contact's AI tab,
   or the `ai_analyze` automation firing on a new lead (which also raises a
   "Review AI-drafted reply" task).
2. The AI tab shows the summary/fit/urgency, an **editable** email + SMS, and up to
   3 proposed booking times (Claude is given the company's real calendar; anything
   overlapping an existing job or in the past is filtered out server-side).
3. You edit if needed and press **Send email** / **Send SMS** → two-step confirm →
   it goes out via Resend / Twilio. Edits are saved automatically on send, so what
   you see is what is sent.
4. **Confirm** on a proposed time creates the booking. One booking per draft.

Operational notes:
- A sent channel is **read-only and cannot be re-sent** — the guard is in the
  service, not just the UI.
- Sends **never auto-retry**: a timeout is ambiguous and a retry could double-text
  a customer. A failure shows the provider's real error; press send again yourself.
- Drafts are the audit trail of what was sent (no delete policy). The stored
  `analysis` is Claude's original output, kept even after a human edits the reply.
- If a send fails with "not configured", the web service is missing
  `OUTBOUND_FROM_EMAIL`/`RESEND_API_KEY` or the `TWILIO_*` trio.

---

_Appended as they land: **Phase 2 spoke fan-out** (Care + Storage dual-send to intake, alongside the legacy hub); **Phase 5** (full end-to-end matrix + cutover criteria to retire the legacy `leads.a1marinecare.ca` hub to fallback)._
