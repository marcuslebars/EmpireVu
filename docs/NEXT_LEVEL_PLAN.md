# EmpireVu — Next Level Plan v2 (Claude Code execution file, Tasks 0–26)

> **This file supersedes the previous `docs/NEXT_LEVEL_PLAN.md` and `docs/AI_TEAM_PLAN.md`.** One protocol, one task list, one numbering. If those files exist in the repo, replace them with this one and update any references.
>
> **How to use this file**
> 1. Commit as `docs/NEXT_LEVEL_PLAN.md`.
> 2. In Claude Code: `Read docs/NEXT_LEVEL_PLAN.md. Execute Task 0 only. Follow the Working Protocol exactly.`
> 3. Review the result, merge, then `Execute Task 1 only.` — and so on. Never run two tasks in one session. Each task = one reviewable PR.
> 4. If a task was already completed in a previous session, verify its acceptance criteria still hold (grep, don't assume), report, and stop — do not redo it.
>
> Tasks are ordered so that (a) A1 keeps working unchanged throughout, (b) every task's tests pass before the next starts, and (c) foundation lands before product. Do not reorder without a reason written into the PR.

## What this plan builds

**Phase 1 (Tasks 0–7): foundation.** Correct read models, durable webhooks, abuse controls, usage metering, generated types, CI, and multi-tenant edges — so a tenant that isn't A1 can exist without a deploy.

**Phase 2 (Tasks 8–17): the product.** Workflow engine v2 (messaging actions, delays, time triggers), playbook library, inbound SMS + realtime, unified inbox, self-serve onboarding, attribution, digest, mobile PWA, hardening.

**Phase 3 (Tasks 18–26): the AI team.** EmpireVu stops being "a CRM with automations" and becomes a roster of **named AI employees** a small-business owner hires one at a time. Each employee has a role, a persona, working hours, an **autonomy level per action type** (draft-only → act-with-approval → act-and-report), and a **monthly scoreboard** proving what it earned. The workflow engine remains the deterministic spine; Claude sits at the edges (classify, extract, draft, judge). Nothing in this plan introduces free-roaming agents.

The roster and where each comes from:

| Employee | Role key | What it owns | Built from |
|---|---|---|---|
| Marina | `front_desk` | Calls, texts, web leads, bookings | Exists (Retell + intake + booking) |
| The Closer (default "Sam") | `closer` | Quote chasing, stale leads, missed-call text-back, review asks | Tasks 8–10 playbooks, re-homed in Task 18 |
| The Money Person (default "Dana") | `money` | Receivables, deposit chasing, payment links | Task 22 |
| The Dispatcher | `dispatcher` | Reminders, no-shows, schedule conflicts | Later — role key reserved, not built here |
| The Marketer | `marketer` | Reviews, seasonal pushes | Later — reserved, not built here |
| The Office Manager | `office_manager` | Morning standup, reports on the others, takes owner commands | Task 15 digest, evolved in Task 23 |

---

## Working Protocol (applies to every task)

You are working in the EmpireVu repository: a multi-tenant CRM / AI-front-office platform. Vite + React SPA (`src/screens`, `src/components`, `src/lib`) served single-origin by a Next.js 14 API runtime (`src/app/api/**`), Supabase/Postgres with RLS on every business table, a DB-backed job queue with Railway polling workers (`src/server/workers/*`), and cron jobs (`src/server/jobs/*`). The service layer is `src/server/services/**`. Tests are Vitest in `src/test/*.test.ts`.

**Before you write anything, read:** `README.md`, `docs/EMPIREVU_RUNBOOK.md`, `docs/EMPIREVU_AUDIT.md`, and every `docs/*.md` relevant to the task. Then read the actual files the task names. Line numbers in this plan are approximate — always `grep` for the symbol rather than trusting the number.

**Non-negotiable conventions — violating any of these fails the task:**

1. **Tenancy.** Every new table gets `organization_id uuid not null references public.organizations(id) on delete cascade`, RLS enabled in the same migration, and policies built on `public.is_organization_member()` / `public.is_organization_admin()`. Company-scoped tables use the composite FK `(company_id, organization_id) references public.companies(id, organization_id)`. Follow the existing pattern in `supabase/migrations/20260321090000_initial_multi_tenant_foundation.sql` exactly.
2. **Service role.** `createSupabaseAdminClient()` may only be imported from modules that already carry a "SANCTIONED EXCEPTION" header comment (lead-intake, public-booking, telnyx, retell, quotes public/checkout/connect, billing, jobber, waitlist, invitations, workers, jobs). If a task needs a new one, add the same header comment explaining why there is no RLS identity, resolve the tenant server-side from something the request cannot forge, and list it in `docs/EMPIREVU_RUNBOOK.md`.
3. **Queue.** Use the existing Postgres queue pattern (`workflow_event_jobs` + `FOR UPDATE SKIP LOCKED` claim RPC). Never add BullMQ, Redis, or any external queue.
4. **Prices are data.** No dollar amounts in code. Customer prices live in Stripe or the per-company catalog. Provider cost rates (Retell, Twilio, Anthropic) may live in env with documented defaults.
5. **Durable-first.** Any inbound webhook or public write persists the raw payload before doing anything else, and before ACKing.
6. **Never drop a lead.** Any failure after the durable write is logged and non-fatal.
7. **Migrations.** Filename `supabase/migrations/YYYYMMDDHHMMSS_short_name.sql` using today's date, strictly after the newest existing file. Additive only. Write the matching `supabase/rollback/<same_name>.down.sql`. If the migration adds tables, regenerate types (Task 2).
8. **Env.** Every new env var goes into `.env.example` with a comment tagging which service consumes it (`[web]`, `[worker]`, `[billing-worker]`, `[reconcile]`, `[quote-maintenance]`, `[jobber-sync]`) — traced from code, not assumed.
9. **Tests.** Every task adds Vitest coverage for its new behavior in `src/test/`. Follow the mocking patterns already in `src/test/setup.ts` and neighbouring tests. Golden fixtures for anything that prices, formats, or routes.
10. **Docs.** Update or create the relevant `docs/*.md`. If the task changes deploy topology or env, update `docs/EMPIREVU_RUNBOOK.md`.
11. **A1 must keep working.** A1 Marine Care / Storage / Coatings / boatnames.ca / a1marineinsurance.ca spokes sign intake with the global `LEAD_INTAKE_SECRET` and send `sourceSite`. That path stays functional until Task 7's cutover checklist is explicitly completed by the owner.
12. **Windows/PowerShell.** The owner runs Windows. Prefer `npm run <script>` over raw shell. If you must chain commands, use `;` not `&&`. No bash-isms in scripts under `scripts/`.
13. **Type escape hatches.** Do not add new `as any` / `as unknown as`. If a table is untyped, that is a signal to run the gen-types script (Task 2), not to cast.
14. **No money-moving or customer-facing action executes without consulting the employee's autonomy config** (once Task 19 exists). Every `send_sms`, `send_email`, `call_lead`, payment-link send, or receivable escalation goes through the Task 19 gate. A code path that bypasses it fails the task.
15. **Compliance posture for collections (Task 22):** all receivable messaging is **first-party** — sent as the business, about the business's own invoice, from the business's identity, with opt-out honored. No third-party-collector language ("this is an attempt to collect a debt"), no threats, no contact-frequency beyond the defined ladder. Write the rules into `docs/messaging-compliance.md` and add a line telling the owner to confirm the templates with counsel before enabling autonomy above draft-only. You are not a lawyer; neither is the owner's software.
16. **Employee naming:** default names live in one config module; every name is owner-editable. Never hardcode "Marina"/"Sam"/"Dana" in templates — always `{{ employee.name }}`.

**Definition of done for every task:**
- `npm run typecheck`, `npm run lint`, `npm run test` all pass (paste the summary lines).
- Migration + rollback written (if any).
- `.env.example` and docs updated.
- A **Handoff** block at the end of your final message containing: files changed, migrations to apply (in order), env vars to set (per service), any manual steps (Stripe dashboard, Retell dashboard, Railway), and anything you deliberately did not do and why.
- Stop. Do not start the next task.

---

# Phase 1 — Foundation

## Task 0 — Orientation and assumption check (no code changes)

**Goal:** Confirm this plan's assumptions against the current repo before any task modifies it.

**Do:**
1. Read all `docs/*.md`, `README.md`, `package.json`, `next.config.mjs`, `vite.config.ts`, every `railway.*.json`, `.env.example`.
2. For each of the following, confirm it is still true and report the exact file:line; if it has changed (e.g. an earlier task already fixed it), say so:
   - `src/server/services/live-data.ts` has a `listAllRows` helper doing `.select("*").eq("organization_id", …)` with no `.range()` / pagination.
   - `src/app/api/intake/route.ts` verifies one global `LEAD_INTAKE_SECRET`; `src/server/services/lead-intake/routing.ts` pins the org to `LEAD_INTAKE_ORG_SLUG` and routes brands via a hardcoded `SOURCE_SITE_TO_COMPANY_SLUG`.
   - `src/server/services/retell/config.ts` reads `RETELL_SOURCE_SITE` from env and `retell/tenant.ts` resolves the tenant from it (not from the dialled number or agent id).
   - `src/server/services/telnyx/tenant.ts` resolves the tenant by dialled number through `telnyx_numbers`.
   - `src/app/api/public/booking/[companyId]/route.ts` POST is unauthenticated with no rate limiting or bot check, and `public-booking.ts` dispatches `contact.created` which can trigger the `call_lead` workflow action.
   - `retell_calls` has no `duration_ms`, `start_timestamp`, `end_timestamp`, or cost columns.
   - `src/server/services/billing/config.ts` `PLAN_FEATURE_DEFAULTS.front_desk` has `workflows: false` and `sms_sequences: false`.
   - `src/app/api/retell/webhook/route.ts` ACKs 200 then `void ingestRetellCall(payload)`.
   - `src/server/services/workflow-engine/types.ts` has no `send_sms`, `send_email`, or `wait` action and no time-based trigger.
   - `tsconfig.app.json` has `strict: false`; `next.config.mjs` has `ignoreBuildErrors: true`; there is no gen-types script; there is no `.github/workflows`.
3. List every table created in `supabase/migrations` that is absent from `src/server/db/database.types.ts`.
4. List every unauthenticated route under `src/app/api` (anything not calling `requireOrganizationContext` / `getAuthenticatedUser`), with its auth mechanism (HMAC, shared secret, token, none).

**Deliver:** a report only. No files changed.

---

## Task 1 — CI, health endpoint, plan-matrix fix

**Goal:** Every later task runs under CI; Railway can health-check; the billing feature matrix is correct.

**Do:**
1. `.github/workflows/ci.yml`: on `pull_request` and `push` to `main`, Node 22, `npm ci`, then `npm run typecheck`, `npm run lint`, `npm run test`. Cache npm. Fail on any non-zero exit.
2. `GET /api/health` (new route, **unauthenticated**, no secrets in output): returns `{ ok, db: "ok"|"error", workers: { workflow_events: { last_claimed_at, queued }, billing_events: {…}, jobber_sync: {…} }, version }`. DB check is a `select 1` via the anon client. Worker freshness reads the newest `claimed_at` / count of `queued` rows from each job table using the admin client — this route is a new sanctioned exception (add the header comment; it reads aggregate counts only, never row content, never tenant data). Return 503 if the DB check fails. Add a 5-second timeout.
3. Add `"healthcheckPath": "/api/health"` to `railway.json` deploy config (verify the schema supports it).
4. Fix `PLAN_FEATURE_DEFAULTS.front_desk` so it is a strict superset of `operate` (`workflows: true`, `sms_sequences: true`, `marina_reception: true`). Update `docs/billing.md` and any test asserting the old matrix.
5. Remove `lovable-tagger` from `devDependencies` and `vite.config.ts` unless the owner has explicitly said to keep it (ask in the handoff if unsure — do not remove silently).

**Tests:** health route returns 200 shape with a mocked DB; 503 on DB error; front_desk superset assertion in `billing-gating.test.ts`.

**Don't:** touch RLS, touch any business logic beyond the matrix constant.

---

## Task 2 — Generated database types + strict server typecheck

**Goal:** Stop the `as any` erosion. Every table is typed; the server tree typechecks under `strict`.

**Do:**
1. Add `scripts/gen-types.mjs` (Node, cross-platform) that runs `supabase gen types typescript` against either `--local` or `--project-id $SUPABASE_PROJECT_REF` (env-selected) and writes `src/server/db/database.types.ts`. Add `npm run gen:types`. Document both modes in `docs/EMPIREVU_RUNBOOK.md`.
2. Run it (or, if no Supabase is reachable in this environment, hand-write the missing table types **from the migrations** using the exact shape the generator produces — and say so in the handoff so the owner re-runs `gen:types`). Missing today: `quote_events`, `retell_calls`, `jobber_connections`, `jobber_sync_jobs`, `company_voice_profiles`, `waitlist`, `service_catalog_items`, `service_catalog_bundles`, `service_catalog_surcharges`, `company_branding`, `company_stripe_customers`, `quote_number_counters`, and any others Task 0 found.
3. Replace every `(supabase as any).from("…")` / `tbl(ctx, "…")` / `as unknown as` cast in `src/server/**` with typed access. Work file by file; do not change behavior.
4. Add `tsconfig.server.json` extending the base with `strict: true`, `noImplicitAny: true`, `include: ["src/server/**", "src/app/**", "src/middleware.ts"]`. Add `npm run typecheck:server`. Fix what it surfaces. Add it to CI. Leave `tsconfig.app.json` strictness as-is for the SPA (Task 17 tightens it).
5. Add a CI step that runs `gen:types` (local mode if the workflow can start Supabase, otherwise skipped with a clear note) and fails if `database.types.ts` has a diff.

**Tests:** existing suite green under the new types. No new behavior.

**Don't:** rename tables/columns, "fix" schema while you're in there.

---

## Task 3 — Read models: replace in-memory joins with SQL views/RPCs

**Goal:** Kill the silent 1,000-row truncation and the O(n²) joins. Every `/ui/*` endpoint reads a purpose-built view or RPC with real pagination.

**Read first:** `src/server/services/live-data.ts` end to end; every route under `src/app/api/organizations/[organizationId]/ui/**`; `src/test/dashboard-activity-shape.test.ts`; the `/ui` client hooks in `src/lib/api-hooks.ts` so response shapes stay byte-compatible.

**Do:**
1. **Tourniquet first (its own commit):** in `listAllRows`, add explicit `.order("created_at", { ascending: false })` and page through with `.range()` in 1,000-row chunks until fewer than 1,000 return. This makes results *correct* immediately (still slow). Add a test that mocks two pages and asserts both are merged.
2. **Migration `..._read_models.sql`** creating, for each screen, a view or `security invoker` function (so RLS applies) that returns exactly the columns the existing TypeScript shape needs:
   - `ui_dashboard_summary(org_id uuid, company_id uuid default null)` → one row with the counts currently computed in `getDashboardSummary` (use `filter (where …)` aggregates).
   - `ui_contact_list_v` — one row per contact with `last_activity_at`, `last_activity_event_type`, `bookings_count`, `upcoming_bookings_count`, `realized_revenue_cents`, `pipeline_value_cents`, company + owner fields. Computed via `lateral` joins, not correlated subqueries where avoidable.
   - `ui_contact_detail(org_id, contact_id)` returning the contact + arrays (`jsonb_agg`) for bookings, tasks, recent events.
   - `ui_calendar_bookings(org_id, company_id, from_ts, to_ts)`.
   - `ui_task_list_v`, `ui_task_detail(org_id, task_id)`.
   - `ui_workflow_list_v`, `ui_workflow_detail(org_id, workflow_id)`, `ui_workflow_jobs_v`.
   - `ui_activity_feed(org_id, company_id, limit, before_ts)` keyset-paginated.
   - `ui_automation_impact(org_id, company_id, since_ts)`.
3. Add the missing indexes these need, at minimum: `activity_events (organization_id, entity_type, entity_id, occurred_at desc)`, `activity_events (organization_id, related_entity_type, related_entity_id, occurred_at desc)`, `activity_events (organization_id, company_id, occurred_at desc)`, `bookings (organization_id, contact_id, scheduled_for)`, `tasks (organization_id, contact_id, status)`, `quotes (organization_id, contact_id, status)`.
4. Rewrite each `live-data.ts` function to call its view/RPC and map to the **unchanged** response type. Delete `listAllRows` when nothing uses it. Pagination on list endpoints becomes keyset (`before`/`after` cursor) — keep the existing `page/pageSize` params working by translating, so the SPA doesn't change in this task.
5. Search (`?search=`) uses `ilike` on a generated `search_text` column (name/email/phone) with a trigram index (`pg_trgm`), not JS filtering.

**Tests:** for every rewritten function, a test that runs the SQL against a Supabase-local instance if available, otherwise a mocked RPC asserting the call shape + the mapping. Add a fixture with 1,500 activity events proving the dashboard count is exact.

**Acceptance:** `/ui/*` responses are shape-identical (snapshot the JSON before/after against seed data). Any `/ui/*` call issues at most 3 queries.

**Don't:** change the SPA in this task; change any write path.

---

## Task 4 — Durable-first inbound webhooks

**Goal:** No inbound call/event can be lost between ACK and processing.

**Read first:** `src/app/api/retell/webhook/route.ts`, `src/server/services/retell/lead-adapter.ts` (`ingestRetellCall`, `upsertRetellCall`), `src/app/api/jobber/webhook/route.ts`, `src/server/services/jobber/webhook.ts`, `src/server/services/workflow-event-jobs.ts`, the queue migration.

**Do:**
1. Migration: `inbound_webhook_jobs` table modeled on `workflow_event_jobs` (`id, provider text, external_id text, organization_id null, company_id null, payload jsonb, status, attempts, max_attempts default 5, claimed_at, claimed_by, last_error, run_at, created_at`) with `unique (provider, external_id)`, RLS enabled with **no** member policies (service-role only), and a `claim_inbound_webhook_jobs(batch int, worker_id text, stale_after_seconds int)` RPC copied from the existing claim function.
2. Retell webhook route: verify signature → parse → `upsert retell_calls` on `call_id` with the raw payload (make this the first write) → insert `inbound_webhook_jobs (provider='retell', external_id=call_id)` on conflict do nothing → **then** return 200. Remove the `void ingest…` fire-and-forget.
3. Jobber webhook route: same pattern (`provider='jobber'`, external_id = Jobber's event id or a hash of the raw body if none).
4. Extend `workflow-event-worker.ts` to also claim `inbound_webhook_jobs` each tick (same process, same Railway service — no new service) and dispatch by provider to `ingestRetellCall` / the Jobber handler. Retries with backoff; `last_error` recorded; ops health (`/ops/jobs-health` and `/api/health`) includes this table.
5. Add an internal retry endpoint mirroring `workflow-event-jobs/[jobId]/retry`.

**Tests:** route returns 200 only after both inserts (mock the admin client and assert order); duplicate delivery is a no-op; worker processes a queued Retell job and produces the same lead the old synchronous path did (reuse fixtures from `retell-lead-adapter.test.ts`).

**Don't:** change lead-adapter business logic; change the intake route (that's HTTP-synchronous by contract with the spokes and already durable-first).

---

## Task 5 — Abuse controls on unauthenticated routes

**Goal:** Nobody can use a public form to spam a tenant's CRM or trigger paid outbound AI calls.

**Read first:** `src/app/api/public/**`, `src/app/api/waitlist/route.ts`, `src/server/services/public-booking.ts`, `src/server/services/workflow-engine/actions.ts` (`call_lead`), `workflow-engine/context.ts`, `src/screens/PublicBookingPage.tsx`, `src/screens/PublicQuotePage.tsx`.

**Do:**
1. **Rate limiter (DB-backed, no Redis).** Migration: `rate_limit_buckets (bucket_key text primary key, window_started_at timestamptz not null, hits int not null)` + `consume_rate_limit(p_key text, p_limit int, p_window_seconds int) returns boolean` as a single atomic `insert … on conflict do update` that resets the window when expired and returns whether `hits <= p_limit`. RLS on, no policies. Service `src/server/services/rate-limit.ts` with `enforceRateLimit(request, { scope, limit, windowSeconds, keyParts })` returning a 429 `NextResponse` or null. Key on client IP (`x-forwarded-for` first hop) and on the resource (company id / token). Apply:
   - `POST /api/public/booking/[companyId]`: 5 / 10 min per IP, 60 / hour per company.
   - `GET /api/public/booking/[companyId]`: 60 / 10 min per IP.
   - `POST /api/waitlist`: 3 / hour per IP.
   - `POST /api/public/quotes/[token]/{approve,reprice}`: 20 / 10 min per token.
   - `POST /api/intake`, `/api/retell/*`, `/api/telnyx/*`, `/api/jobber/webhook`, `/api/webhooks/stripe/*`: 600 / min per IP (generous; these are signed — DoS backstop only).
2. **Cloudflare Turnstile** on the public booking form and waitlist form. Client: `VITE_TURNSTILE_SITE_KEY`; server: `TURNSTILE_SECRET_KEY`, verified via `https://challenges.cloudflare.com/turnstile/v0/siteverify` in `src/server/services/turnstile.ts`. Behavior: if `TURNSTILE_SECRET_KEY` unset and `NODE_ENV !== "production"`, skip with a `console.warn`; in production unset → 503 (same convention as intake). Add a honeypot field (`website`, visually hidden) and a `formStartedAt` timestamp: reject if honeypot filled or submitted in < 3 s.
3. **Engine-level guard for paid actions.** In `actions.ts`, before executing `call_lead` (and later `send_sms`), call a new `assertPaidActionAllowed(context, eventContext, action)` in `workflow-engine/guards.ts`:
   - Determine if the trigger event is *unauthenticated-sourced*: `activity_event.actor_profile_id is null` **and** `metadata.source ∈ {public_booking, waitlist, intake_unverified}` (make public-booking and waitlist stamp this metadata; intake stamps `intake` since it's HMAC-signed).
   - If so: refuse if the same normalized phone (last-10) received an outbound call from this company in the last 24 h (query `retell_calls` / `activity_events contact.call_placed`), and refuse if the company has exceeded a daily cap of unauthenticated-sourced outbound calls (default 20; overridable via `feature_flags` `limit_value` for a new feature key `public_outbound_calls_daily`).
   - A refusal records a `workflow_runs` failure reason `guard:cooldown` / `guard:daily_cap` (not an exception) so the run is visible in Automations.
4. Log all 429s and guard refusals with org/company ids (no PII).

**Tests:** limiter allows N then 429s; window resets; honeypot/too-fast rejected; Turnstile skip vs enforce by env; guard refuses second call within 24 h and allows after; daily cap respected; authenticated-sourced events bypass the guard.

**Don't:** rate-limit authenticated org routes (session + RLS already bound them); add captcha to the hosted quote page (the token is the auth).

---

## Task 6 — Usage ledger, minutes metering, AI cost controls

**Goal:** Every metered thing (voice minutes, SMS, email, AI tokens) is recorded once, rolled up monthly, enforceable via `orgLimit`, and visible per tenant.

**Read first:** `src/server/services/billing/{config,gating}.ts`, `retell/lead-adapter.ts` + `retell/payload.ts`, the `retell_calls` migration, `outbound/{sms,email}.ts`, `src/server/ai/claude.ts`, `src/server/ai/workflow-author.ts`, Retell's `call_analyzed` payload (see `docs/retell-integration.md` and fixtures).

**Do:**
1. Migration:
   - Add to `retell_calls`: `duration_ms int`, `start_timestamp timestamptz`, `end_timestamp timestamptz`, `call_cost_cents int`, `cost_breakdown jsonb`. Populate from the payload in `readRetellCallFields` / `upsertRetellCall`.
   - `usage_events (id, organization_id not null, company_id, kind text not null check (kind in ('voice_minutes','sms_sent','sms_received','email_sent','ai_input_tokens','ai_output_tokens','ai_cache_read_tokens')), quantity numeric not null, unit text not null, cost_cents int, provider text, provider_ref text, occurred_at timestamptz not null default now(), metadata jsonb)` + `unique (provider, provider_ref, kind)` for idempotency + RLS (members select; no insert policy — service-role writes only) + index `(organization_id, kind, occurred_at desc)`.
   - View `usage_monthly_v (organization_id, company_id, month, kind, quantity, cost_cents)` with `security_invoker`.
2. Service `src/server/services/usage.ts`: `recordUsage(admin, {...})` (idempotent on provider_ref), `getMonthlyUsage(supabase, orgId, month)`, `getUsageForFeature(supabase, orgId, feature)` mapping `marina_reception → voice_minutes`, `sms_sequences → sms_sent`.
3. Write usage from: Retell ingest (`voice_minutes = duration_ms/60000`, `cost_cents` from Retell's cost if present, `provider_ref = call_id`); `outbound/sms.ts` (`provider_ref = Twilio SID`); `outbound/email.ts` and `lead-intake/notify.ts` (`provider_ref = Resend id`); `ai/claude.ts` and `workflow-author.ts` (tokens from `response.usage`, `provider_ref = response.id`, `cost_cents` from env-overridable per-million rates in `ai/pricing.ts` with documented defaults).
4. Limits: set `PLAN_FEATURE_LIMITS.front_desk.marina_reception = 500` (minutes). Make `orgLimit` + a new `orgUsageRemaining(supabase, orgId, feature)` consult `usage_monthly_v`. `requireFeature` for `marina_reception` now also refuses when remaining ≤ 0 with a distinct error (`UsageCapExceeded` → 402 in `handleRoute`). Apply to `/voice/call` and to the `call_lead` action (via the Task 5 guard). Inbound Marina calls are **never** refused (a receptionist that stops answering is worse than overage) — when a Front Desk tenant crosses 500, record it and surface an "overage" state in billing; overage billing to Stripe is a later task.
5. AI cost controls: add `cache_control: { type: "ephemeral" }` on the static system-prompt block in both Claude call sites; route `ai-drafts` and `ai-workflows` through a `model` config in `ai/config.ts` (`AI_MODEL_DRAFTS`, `AI_MODEL_WORKFLOWS`, defaults = current values) so the owner can move drafts to a smaller model without a code change.
6. UI: on `/settings/billing`, a "This month" panel: minutes used / cap, SMS sent, emails sent, AI cost estimate. Internal ops page: per-tenant cost vs MRR table (MRR from `subscriptions` + Stripe price).

**Tests:** usage recorded once per provider_ref on duplicate webhook delivery; minutes rounding; cap refusal at 500; inbound never refused; AI usage captured from a mocked SDK response; monthly view sums correctly across a month boundary (America/Toronto).

---

## Task 7 — Multi-tenant edges: intake keys, voice numbers, Retell by number

**Goal:** A brand-new tenant can receive web leads and Marina calls without any env change or deploy. A1 spokes keep working until cut over.

**Read first:** everything in `src/server/services/lead-intake/`, `src/app/api/intake/route.ts`, `src/server/services/retell/{config,tenant,lead-adapter}.ts`, `src/server/services/telnyx/tenant.ts`, the `telnyx_numbers` and `company_voice_profiles` migrations, `docs/LEAD_SCHEMA.md`, `docs/retell-integration.md`, `docs/telnyx-integration.md`.

**Do:**
1. Migration:
   - `intake_keys (id, organization_id, company_id, key_prefix text (first 8 chars, for display), key_hash text (sha256 of the full key), label, active bool, last_used_at, created_by, created_at)` + `unique (key_hash)` + RLS (admins manage, members read). Composite FK on company.
   - `voice_numbers (id, organization_id, company_id, phone_e164 text unique, provider text check (provider in ('retell','telnyx')), provider_agent_id text, brand_label text, active bool, created_at)`. Migrate existing `telnyx_numbers` rows into it (keep the old table one release for rollback; mark deprecated in docs).
   - Index `voice_numbers (provider_agent_id)`.
2. Intake route: read the key from `x-empirevu-key` header. Resolution order: (a) `intake_keys` by hash → org+company pinned from the row; (b) **legacy fallback**: if no key header and the `x-empirevu-signature` HMAC verifies against `LEAD_INTAKE_SECRET`, resolve via the existing `LEAD_INTAKE_ORG_SLUG` + `SOURCE_SITE_TO_COMPANY_SLUG` path and log `intake.legacy_auth_used` once per hour per sourceSite. The HMAC body signature stays mandatory in both modes (sign with the intake key itself in mode (a)). `sourceSite` becomes a free-text tag stored on the lead in both modes.
3. Retell tenant resolution (`resolveRetellTenant`): inbound → lookup `voice_numbers` by `to_number` (E.164), then by `agent_id`, then legacy `RETELL_SOURCE_SITE` env with a deprecation warning. Outbound → keep metadata-based resolution (already correct). `company_voice_profiles` remains the per-company prompt/voice config; `voice_numbers.provider_agent_id` links a number to its Retell agent.
4. Telnyx: point `resolveTenantByCalledNumber` at `voice_numbers where provider='telnyx'`.
5. Settings UI → new "Integrations" tab: create/revoke intake keys (show full key **once** on creation), copy-paste snippet for the site (`POST … x-empirevu-key`), list voice numbers per company (add/deactivate; API provisioning arrives in Task 13 — here it's manual entry).
6. Scripts: `scripts/dev/sign-intake.mjs` that signs a sample envelope with a given key for spoke testing.
7. `docs/LEAD_SCHEMA.md` + a new `docs/tenant-provisioning.md` with the **cutover checklist** for A1's five spokes (issue key → update spoke env → verify `intake.legacy_auth_used` stops → remove legacy secret).

**Tests:** key-mode resolves tenant from the key only (payload cannot override); revoked key → 401; legacy mode still routes A1 brands byte-identically (reuse `intake-route.test.ts` fixtures); Retell inbound resolved by number, then agent, then env; unmapped number → lead still stored with null company and `needs_attention`.

**Don't:** remove the legacy path in this task.

---

# Phase 2 — Product

## Task 8 — Workflow engine v2 (part 1): messaging actions + consent

**Goal:** Workflows can text and email customers and alert the owner, with CASL-safe consent handling.

**Read first:** `src/server/services/workflow-engine/*`, `src/server/outbound/{sms,email}.ts`, `src/server/services/ai-drafts.ts` (the draft→send pattern), `docs/telnyx-integration.md` (existing CASL/CRTC patterns), `contacts` schema.

**Do:**
1. Migration: add to `contacts`: `sms_consent_at timestamptz`, `sms_opt_out_at timestamptz`, `email_opt_out_at timestamptz`, `consent_source text`. Backfill `sms_consent_at = created_at` and `consent_source='implied_inquiry'` for contacts created by intake/public-booking/Retell (they initiated contact — implied consent under CASL; document the reasoning and the implied-consent expiry in `docs/messaging-compliance.md`). Add `message_log (id, organization_id, company_id, contact_id, channel text, direction text, provider, provider_ref, to_addr, from_addr, subject, body, status, error, workflow_run_id, created_at)` + RLS + index on `(organization_id, contact_id, created_at desc)`. Every outbound message writes here (and to `usage_events` via Task 6).
2. New actions in `types.ts` + `actions.ts`:
   - `send_sms { to?: "contact"|"owner"|E164, body: string (interpolated), time_saved_seconds? }`
   - `send_email { to?: "contact"|"owner"|email, subject, body, html?, from_name? (defaults to company name via company_branding), reply_to? }`
   - `notify_owner { channel: "sms"|"email"|"both", subject?, body }` — owner = `OWNER_EMAIL` / new `companies.owner_phone_e164` + `companies.owner_email` columns (fall back to org owner profile).
   - All three: dry-run projects the resolved payload; real run checks consent (`sms_opt_out_at is null`, consent not expired), applies the Task 5 paid-action guard for `send_sms`, sends via `outbound/*`, writes `message_log`, and emits `contact.sms_sent` / `contact.email_sent` activity events **without** re-triggering workflows on those events (add an `emit_only` option to `emitActivityEventAndDispatch` to prevent loops).
   - Interpolation: extend `context.ts` so templates can reference `{{ contact.first_name }}`, `{{ company.name }}`, `{{ booking.scheduled_for | date }}`, `{{ quote.public_url }}`, `{{ company.booking_url }}`. Add a small filter set (`date`, `time`, `money`) with the business timezone.
3. STOP handling scaffold: `send_sms` bodies get a one-time footer `Reply STOP to opt out` on the first message to a contact per company (tracked via `message_log`). Inbound STOP processing lands in Task 11.
4. Automations UI: the action editor supports the three new actions with a live preview of the interpolated body against a sample contact (reuse `run-test`).

**Tests:** consent refusal; opt-out refusal; interpolation + filters (golden); loop prevention; owner routing fallback; message_log written on success and failure.

---

## Task 9 — Workflow engine v2 (part 2): delays, time triggers, new event triggers

**Goal:** Sequences ("wait 2 days, then…") and schedules ("every day at 08:00", "24h before booking") run on the existing queue.

**Read first:** `workflow-engine/processor.ts`, `workflow-event-jobs.ts`, `workflow-runs.ts`, the `workflow_runs` schema, `src/server/workers/workflow-event-worker.ts`, `quotes/service.ts` (where sent/viewed/approved happen), `retell/lead-adapter.ts` (where a missed call is detected), `bookings.ts`.

**Do:**
1. Migration: `workflow_runs` gets `current_step_index int default 0`, `resume_at timestamptz`, `status` gains `'waiting'` (extend additively). New `workflow_schedule_ticks (id, organization_id, workflow_id, scheduled_for timestamptz, status, claimed_at, claimed_by, last_error)` with unique `(workflow_id, scheduled_for)` and a claim RPC. Index `workflow_runs (status, resume_at) where status='waiting'`.
2. `wait` action: `{ type: "wait", duration: "2d"|"4h"|"30m" | until: "booking.scheduled_for - 24h" }`. Processor executes actions sequentially; on `wait`, persist `current_step_index`, set `resume_at`, status `waiting`, and return. The worker each tick claims `waiting` runs with `resume_at <= now()` (add `claim_waiting_workflow_runs` RPC, SKIP LOCKED) and resumes from `current_step_index` with the original event context (stored via `trigger_event_id`). A resumed run re-evaluates a `resume_conditions` array if present (e.g. "quote still not viewed") so sequences stop when the customer acts.
3. New triggers (emit from the service layer; each is an `activity_events` row with the right `entity_type`):
   - `call.missed` (Retell/Telnyx: inbound call with `in_voicemail` or duration < 5 s or `call_successful=false` — define precisely in code + docs), `call.completed`, `call.urgent` (`is_urgent`).
   - `quote.sent`, `quote.viewed` (first view), `quote.approved`, `quote.expiring` (24h before `valid_until`; emitted by the schedule tick).
   - `booking.upcoming` (emitted by the scheduler N hours before `scheduled_for`; N configurable per workflow), `booking.cancelled`, `booking.no_show`.
   - `contact.stale` (no activity for N days while stage = lead; scheduler).
   - `schedule.daily` (per-workflow local time + timezone; scheduler).
4. Scheduler: a job type inside the existing worker (no new service) that every minute computes due `workflow_schedule_ticks` for active workflows with time-based triggers and enqueues them idempotently. Timezone from `companies.timezone` (add column, default `BUSINESS_TIMEZONE`).
5. Automations UI: trigger picker includes the new triggers; `wait` step editor; run detail shows waiting state + resume time.

**Tests:** wait persists and resumes with context; resume_conditions abort; scheduler emits exactly once per slot across restarts; DST boundary for `schedule.daily` in America/Toronto; each new trigger fires from its service call (extend `core-loop.test.ts`).

---

## Task 10 — Playbook library + AI author grounding

**Goal:** Every new company gets a set of proven automations on day one; the AI workflow author proposes from them. (These installable workflows are called **playbooks** in UI copy; the code directory keeps the `recipes/` name to avoid churn. Task 18 assigns each playbook an owning employee role.)

**Read first:** `workflow-engine/definitions.ts`, `workflows.ts`, `companies.ts`, `src/server/ai/workflow-author.ts`, `src/app/api/organizations/[organizationId]/workflows/suggest/route.ts`.

**Do:**
1. `src/server/services/workflow-engine/recipes/` — one file per playbook exporting a typed `WorkflowDefinition` + metadata (`slug`, `name`, `description`, `default_status: 'active'|'draft'`, `requires: ['sms'|'email'|'voice']`):
   - `missed-call-text-back` (trigger `call.missed` → `send_sms` within seconds: "Hi {{contact.first_name}}, sorry we missed you — {{company.name}} here. Book here: {{company.booking_url}} or reply and we'll call you back."). **Active by default.**
   - `new-lead-owner-alert` (`contact.created` → `notify_owner`). Active.
   - `quote-follow-up` (`quote.sent` → wait 2d, resume if not viewed → `send_sms` → wait 3d, resume if not approved → `send_email` → `create_task` for owner). Active.
   - `booking-reminder` (`booking.upcoming` 24h → `send_sms`; 2h → `send_sms`). Active.
   - `stale-lead-nudge` (`contact.stale` 3d → `create_task`). Active.
   - `review-request` (`booking.completed` → wait 1d → `send_sms` with `{{company.review_url}}` — add `company_branding.review_url`). Draft.
   - `no-show-recovery` (`booking.no_show` → `send_sms` + `create_task`). Draft.
   - `urgent-call-escalation` (`call.urgent` → `notify_owner` both channels). Active.
2. `installRecipes(ctx, companyId, { only?: slug[] })` called from `createCompany` and from a new `POST /workflows/recipes/install` route; idempotent via `workflows.slug`. A playbook whose `requires` isn't configured (no SMS provider) installs as draft with a `disabled_reason`.
3. Workflow author: include the playbook definitions as few-shot examples in the system prompt (cached via Task 6's `cache_control`); validate its output against the v2 action/trigger schema with zod before returning.
4. Automations UI: "Playbooks" section — install / preview / customize; each shows `estimated_time_saved_seconds`.
5. Seed A1 companies with the playbook set (draft for anything that would text real customers until the owner flips it).

**Tests:** install idempotent; disabled_reason set when provider missing; every playbook passes `run-test` against fixture events; author output validates.

---

## Task 11 — Inbound SMS + Realtime

**Goal:** Customers can reply; STOP works; the UI updates live.

**Read first:** `outbound/sms.ts` (Twilio config), `lead-intake/matching.ts`, `activity-events.ts`, Supabase Realtime docs, `src/lib/api-hooks.ts`, `src/screens/{Dashboard,ContactDetailPage}.tsx`.

**Do:**
1. `POST /api/twilio/sms/inbound` — validates `X-Twilio-Signature` (HMAC-SHA1 over the full URL + sorted params with `TWILIO_AUTH_TOKEN`; implement in `src/server/services/twilio/signature.ts`, fail closed), durable-first into `inbound_webhook_jobs (provider='twilio', external_id=MessageSid)`, returns empty TwiML `<Response/>`. Worker handler: resolve company by `To` via `voice_numbers` (extend `provider` check to include `'twilio'` and add SMS-capable numbers), match contact by `From` last-10 within that company (create a contact with `consent_source='inbound_sms'` if none), write `message_log direction='inbound'`, emit `contact.sms_received`, record `usage_events sms_received`. Keywords: `STOP/UNSUBSCRIBE/CANCEL/END/QUIT` → set `sms_opt_out_at`, emit `contact.sms_opted_out`, no auto-reply beyond Twilio's own; `START/YES/UNSTOP` → clear opt-out, set `sms_consent_at`.
2. `contact.sms_received` is a workflow trigger (add to Task 9's list) so "customer replied → notify owner + task" works and quote sequences abort via `resume_conditions`.
3. Realtime: migration `alter publication supabase_realtime add table public.activity_events, public.message_log;`. Client hook `useOrgRealtime(orgId)` subscribing to inserts filtered by `organization_id`, invalidating the React Query keys for dashboard, activity feed, the open contact, and inbox. RLS already gates what the subscription can see; confirm with a test that a non-member subscription receives nothing (document how you verified).
4. `AutomationNotifier.tsx` shows a toast on `contact.sms_received` and `call.missed`.

**Tests:** signature valid/invalid; STOP/START state machine; contact match vs create; realtime hook invalidates on insert (mock channel).

---

## Task 12 — Unified conversation inbox (and ContactDetail decomposition)

**Goal:** One place to see and answer everything — calls, texts, emails, web forms, AI actions — per contact and org-wide.

**Read first:** `src/screens/ContactDetailPage.tsx` (1,500+ lines — you will split it), `traces.ts`, `ai-drafts.ts`, the Task 3 views, `message_log`, `retell_calls`, `raw_leads`.

**Do:**
1. **Decompose first (own commit, no behavior change):** split `ContactDetailPage.tsx` into `src/components/contact/{Header,Timeline,QuotesPanel,BookingsPanel,TasksPanel,AiDraftPanel,VoicePanel}.tsx` with state lifted into `src/hooks/useContactDetail.ts`. Same for `TasksPage`/`AutomationsPage` only if necessary; otherwise leave.
2. Read models (Task 3 style): `ui_conversation_thread(org_id, contact_id, before_ts, limit)` returning a unified, keyset-paginated stream of `message_log` rows, `retell_calls` (summary + transcript link), `activity_events` for `contact.*` and `quote.*`, `ai_drafts`, `raw_leads` for that contact. `ui_inbox_v` — org-level: one row per contact with `last_inbound_at`, `last_outbound_at`, `needs_reply bool` (last inbound newer than last outbound), `unread bool`, `channel`, snippet; sorted needs_reply then recency; filter by company.
3. UI: `/inbox` (add to nav): left list from `ui_inbox_v`, right pane = the contact thread with a composer (SMS / email; email uses the existing draft→send pattern, SMS sends directly via a new `POST /contacts/[id]/messages` that goes through consent + `message_log`). Call rows expand to transcript + summary + "call back with Marina" (`QuickCallDialog`). Mark-read state per user (`contact_read_state (organization_id, contact_id, profile_id, last_read_at)`).
4. The contact Timeline component switches to `ui_conversation_thread`.
5. Realtime from Task 11 keeps both panes live.

**Tests:** thread ordering/pagination across sources; `needs_reply` logic; composer consent refusal; read-state.

---

## Task 13 — Self-serve onboarding wizard

**Goal:** A stranger goes from signup to a working AI-receptionist number and website lead form in under 20 minutes, unassisted. Every step provisions something real and is instrumented.

**Read first:** `src/screens/OnboardingPage.tsx`, `organizations.ts`, `companies.ts`, `company-voice-profiles.ts`, `quotes/{catalog,catalog-repo,connect}.ts`, `scripts/dev/generate-a1-catalog.mjs`, `src/server/ai/claude.ts`, `docs/retell-integration.md`, Retell API docs (agent create/update, phone number list/import/purchase — **read the live docs, don't guess endpoints**), `docs/stripe-org-scoping.md`.

**Do:**
1. Migration: `onboarding_progress (organization_id, company_id, step text, status, data jsonb, completed_at)` + `onboarding_events (organization_id, step, event, occurred_at, metadata)` (RLS, members). Add `companies.timezone`, `companies.hours jsonb`, `companies.service_area text`, `companies.website_url` if absent.
2. Steps (each a route in `src/app/api/organizations/[organizationId]/onboarding/*` and a screen in `src/screens/onboarding/*`):
   1. **Business** — name, website, timezone, hours, service area, owner phone/email → `companies` + `company_branding` (logo upload to Supabase Storage bucket `branding`, RLS by org).
   2. **Services** — "Paste your website URL": server fetches the page(s) (10 s timeout, strip scripts/styles, cap 60 KB), sends to Claude with a strict JSON schema for `service_catalog_items` drafts (base price **left blank** unless clearly stated on the site), returns drafts for the user to edit/confirm before insert. Manual add/edit also available. Record token usage.
   3. **Phone** — list numbers available via Retell (or "I already have a number" → port instructions); on selection: create a Retell agent from `company_voice_profiles` (generated from steps 1–2: name, hours, services, booking URL, transfer number), attach the number, write `voice_numbers`, set `provider_agent_id`. Encapsulate in `src/server/services/retell/provision.ts` with idempotency (re-running updates, never duplicates). Secrets stay server-side.
   4. **Payments** — Stripe Connect onboarding link (exists) → poll status.
   5. **Website leads** — issue an intake key (Task 7), show the snippet + a "send a test lead" button that posts a signed envelope from the server so the user sees it appear.
   6. **Test call** — show the number; user calls it; the Realtime feed (Task 11) shows the `retell_calls` row and lead appear on this screen. Mark step complete when it does.
   7. **Team** — invitations (exists).
   8. **Build your team** — playbook/employee hire step (Task 21 upgrades this; until then, the Task 10 playbook toggles).
3. Progress persists; the wizard is resumable from `/onboarding`; dashboard shows a checklist card until complete.
4. Instrumentation: every step start/complete/error → `onboarding_events`. Internal ops page: funnel + median time-to-complete per step (this is how the "<2 hours" gate gets proven).

**Tests:** URL→catalog parser with fixture HTML (golden); provisioning idempotent with a mocked Retell client; intake test-lead round trip; progress resume.

**Don't:** call Retell's real API in tests; store any Retell/Stripe secret client-side.

---

## Task 14 — Revenue attribution report

**Goal:** "Revenue captured by EmpireVu this month" is a number on the dashboard, with a drill-down, per company.

**Read first:** `raw_leads`, `contacts`, `quotes` (`source_lead_id`, `auto_generated`, `source`), `quote_events`, `retell_calls`, `message_log`, Stripe checkout/webhook code for paid amounts, `live-data.ts` automation-impact.

**Do:**
1. Migration: view `revenue_attribution_v` — one row per approved/paid quote with: `first_touch_source` (intake sourceSite / retell / public_booking / manual), `first_touch_channel` (web/voice/sms/email), `marina_involved bool` (a `retell_calls` row for the contact before approval), `automation_involved bool` (a `workflow_runs` succeeded row targeting the contact before approval), `approved_cents`, `paid_cents` (from Stripe payment events; define precisely), `approved_at`, `paid_at`, `company_id`, `organization_id`. `security_invoker`.
2. RPC `ui_attribution_summary(org_id, company_id, from, to)` → totals by source/channel + AI/automation splits + count of quotes.
3. Dashboard card "Captured by EmpireVu" (approved + paid, AI-involved and automation-involved, vs total) with a link to `/reports/attribution` (new screen: table + a Recharts bar by source; CSV export).
4. Add `estimated_time_saved` total for the period next to it (already computed on runs).

**Tests:** attribution rules on a fixture graph (lead → call → quote → approve → pay); a quote with no lead attributes to `manual`; period boundaries in local time.

---

## Task 15 — Owner daily digest

**Goal:** Every morning the owner knows what happened overnight and what needs them, without opening the app. (Task 23 re-homes this under the Office Manager employee and makes it two-way.)

**Read first:** Task 9 scheduler, `notify_owner` action, `message_log`, `ui_inbox_v`, `usage_monthly_v`, `outbound/{sms,email}.ts`.

**Do:**
1. `companies.digest` settings (`enabled`, `send_at_local` default `06:30`, `channels`). Settings UI toggle.
2. Scheduler job type `owner_digest` (Task 9 machinery): at the local time, compute for the last 24 h: calls (total / booked / quotes sent / needs callback), new leads, messages needing reply, quotes unviewed > 48 h, today's bookings, usage vs cap, and `revenue_attribution` for the month so far. Render a plain-text SMS (≤ 320 chars, deep link to `/inbox`) and an HTML email (template in `src/server/templates/digest.ts`, reuse the quote email styling). Send via `notify_owner` plumbing; write `message_log`; idempotent per `(company_id, date)`.
3. "Send me a test digest now" button in settings.

**Tests:** content golden for a fixture day; idempotency; skip when nothing happened (send a one-line "quiet night" only if `always_send` is on).

---

## Task 16 — Owner mobile PWA

**Goal:** A one-thumb owner view: today, callbacks, approve/send quote, listen to calls, call back.

**Read first:** `index.html`, `src/App.tsx`, `AppLayout.tsx`, the Task 12 inbox, `QuickCallDialog`, Vite PWA options.

**Do:**
1. `public/manifest.webmanifest` + a minimal service worker (app-shell caching only; **never** cache `/api/*`). Install prompt on mobile.
2. Route group `/m/*` with a mobile-first layout (bottom tab bar: Today · Inbox · Quotes · Team): Today = bookings + callbacks + digest summary; Inbox = Task 12 list/thread condensed; Quotes = draft/sent/approved with one-tap send; Team = recent AI-employee activity + approvals (Task 19 wires the approvals tab fully). Reuse existing hooks; no new API surface beyond what Tasks 3/12/19 provide.
3. Desktop `/` redirects to `/m` on narrow viewports only if the user opted in (setting), so nothing changes for current users by default.

**Tests:** route rendering smoke tests; SW never caches API (assert the fetch handler's exclusion list).

---

## Task 17 — Clean-up and hardening pass

**Goal:** Pay down what accumulated; tighten what earlier tasks loosened. (Can run any time after Task 13; doesn't block Phase 3.)

**Do:**
1. Remove the legacy intake path **only if** `docs/tenant-provisioning.md` cutover checklist is marked complete by the owner (ask; otherwise skip and say so).
2. Remove `telnyx_numbers` (rollback note), `SOURCE_SITE_TO_COMPANY_SLUG`, `RETELL_SOURCE_SITE`, `TELNYX_DEFAULT_TENANT_ID` with deprecation notes if unused.
3. Tighten `tsconfig.app.json` to `strict: true` and fix the SPA; flip `next.config.mjs` `ignoreBuildErrors` to `false` once `typecheck:server` is the same strictness.
4. Sentry (or the owner's chosen provider) on web + workers, tagging `organization_id` and `company_id`; source maps uploaded in CI. Replace bare `console.error` in server code with a `logger` module (structured JSON, PII-scrubbed: strip phone/email values).
5. Add Playwright smoke suite (already a devDependency): signup → onboarding through step 2 → create contact → send quote → public quote page renders. Run in CI against Supabase local if feasible; otherwise nightly.
6. Docs sweep: `README.md` architecture section, runbook topology diagram, a `docs/ARCHITECTURE.md` that lists every sanctioned service-role module, every unauthenticated route with its auth mechanism, every worker/job with its schedule, and every usage kind.

---

# Phase 3 — The AI team

**Prerequisite check for every Phase 3 task:** verify the listed prerequisite tasks are actually in the codebase (grep for the symbols, don't assume). If one is missing, **stop and report** — do not build around it.

## Task 18 — The employee layer: `ai_employees`, roles, personas, the Team page

**Goal:** Employees exist as first-class rows. Playbooks (Task 10) are owned by employees. The stub Team page becomes the AI team roster.

**Prerequisites:** Tasks 2, 7, 8–10.

**Read first:** `company-voice-profiles.ts` + its migrations, `workflow-engine/recipes/*`, `workflows.ts`, `companies.ts`, `src/screens/TeamPage.tsx` (stub), `AppSidebar.tsx`, `docs/retell-integration.md`.

**Do:**
1. Migration `..._ai_employees.sql`:
   - `ai_employees (id uuid pk default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade, company_id uuid not null, role text not null check (role in ('front_desk','closer','money','dispatcher','marketer','office_manager')), name text not null, persona jsonb not null default '{}', channels jsonb not null default '{}', working_hours jsonb, status text not null check (status in ('not_hired','active','paused')) default 'not_hired', autonomy jsonb not null default '{}', voice_profile_id uuid references company_voice_profiles(id), hired_at timestamptz, paused_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(), unique (company_id, role), unique (id, organization_id), foreign key (company_id, organization_id) references companies (id, organization_id))`. RLS: members select, admins insert/update. No delete policy (pause instead; history must survive).
   - Add nullable `ai_employee_id uuid` (+ composite FK to `ai_employees(id, organization_id)`) to: `workflows`, `workflow_runs`, `message_log`, `retell_calls`, `quotes` (who chased it), `usage_events`. (`pending_actions` gets its column in Task 19.) Indexes on `(organization_id, ai_employee_id)` for `message_log`, `workflow_runs`, `usage_events`.
   - Backfill: for each company with a `company_voice_profiles` row, insert an active `front_desk` employee named from the profile (or "Marina"), link `voice_profile_id`, stamp existing `retell_calls`/voice `usage_events` for that company with the employee id.
2. `src/server/services/ai-employees.ts`: `listEmployees`, `getEmployee`, `hireEmployee(ctx, companyId, role)` (creates row from role defaults, installs that role's playbooks via `installRecipes` with `ai_employee_id` stamped, status `active`, emits `employee.hired` activity event), `pauseEmployee` / `resumeEmployee` (pausing sets owned workflows to `paused`; resuming restores the ones it paused — track which, idempotently), `updateEmployee` (name/persona/channels/hours).
3. Role defaults in `src/server/services/ai-employees/config.ts`: per role — default name, persona (tone, signature template `— {{ employee.name }} at {{ company.name }}`), channels, default autonomy map (Task 19 keys; hardcode the map shape now — all values `'act_with_approval'` except `front_desk` inbound voice = `'act_and_report'` and `money` everything = `'draft_only'`), and the playbook slugs the role owns: `closer` → `missed-call-text-back`, `quote-follow-up`, `stale-lead-nudge`, `review-request`, `no-show-recovery`, `new-lead-owner-alert` (missed-call text-back is *follow-up*, so the Closer owns it, not Marina — document the decision); `front_desk` → none (Marina's behavior lives in the Retell voice profile); `office_manager` → digest (Task 23 rewires); `money` → Task 22 playbooks.
4. `installRecipes` accepts and stamps `ai_employee_id`; playbook metadata gains `owner_role`. Legacy workflows with null employee keep working untouched.
5. Working hours: `send_sms`/`send_email` executed by an employee outside its `working_hours` (company timezone) are **deferred, not dropped** — set the run `waiting` with `resume_at` = next window open (Task 9 machinery). Voice is exempt (Marina answers whenever; that's the point). Owner-facing `notify_owner` is exempt.
6. Message identity: extend Task 8 interpolation context with `employee` (name, signature). `send_sms`/`send_email` executed under an employee append the persona signature unless the template already contains `{{ employee.` — no double-signing.
7. UI: replace the stub `TeamPage.tsx` with two tabs: **AI Team** (roster cards: avatar/initial, name editable inline, role, status, hire/pause, channels, working-hours editor, owned playbooks with toggles, link to scoreboard once Task 20 lands) and **People** (the existing `/members` org users + invitations — wire the orphaned endpoints). "Hire" on a not-hired role card runs `hireEmployee` (seat billing gate arrives in Task 24; until then hiring is free and says so in code comments). Sidebar nav label: "Team".
8. Dashboard: a "Your team" strip — each active employee with a one-line status ("Marina · 14 calls this week"; cheap counts now, real scoreboard in Task 20).

**Tests:** hire is idempotent and installs owned playbooks stamped with the employee; pause/resume round-trips workflow statuses; out-of-hours SMS deferred to window open across a weekend (America/Toronto fixture); signature appended once; backfill assigns Marina and stamps calls; RLS: non-admin member cannot hire.

**Don't:** touch Retell provisioning (Task 13 owns it); build approvals (Task 19); bill seats (Task 24).

---

## Task 19 — Autonomy ladder + approvals inbox

**Goal:** Every consequential action an employee takes passes a per-employee, per-action-type gate: `draft_only` → `act_with_approval` → `act_and_report`. Owners approve from one place. Autonomy changes are themselves tracked (that's the retention metric).

**Prerequisites:** Tasks 18, 9 (`waiting` + resume), 8 (actions), 5 (`workflow-engine/guards.ts`).

**Read first:** `workflow-engine/{processor,actions,guards}.ts`, `workflow_runs` waiting/resume columns, `ai-drafts.ts` (the existing draft→approve→send pattern — you are generalizing it, and Task 12's composer must keep working).

**Do:**
1. Migration `..._pending_actions.sql`:
   - `pending_actions (id, organization_id not null, company_id, ai_employee_id references-composite, workflow_run_id uuid, contact_id uuid, action_type text not null, payload jsonb not null, preview text, status text not null check (status in ('pending','approved','rejected','expired','executed','failed')) default 'pending', expires_at timestamptz, decided_by uuid references profiles(id), decided_at timestamptz, executed_at timestamptz, error text, created_at timestamptz default now())` + composite FKs + RLS (members select; updates via the service — write policies for admins+members on update, enforce transitions in service code) + index `(organization_id, status, created_at desc)`.
   - Autonomy audit: `ai_employee_autonomy_events (id, organization_id, ai_employee_id, action_type, from_level, to_level, changed_by, created_at)` + RLS members select / admins insert.
2. Autonomy keys (the `autonomy` jsonb on `ai_employees`): `send_sms`, `send_email`, `call_lead`, `create_quote`, `send_payment_link`, `escalate_receivable`. Levels: `draft_only | act_with_approval | act_and_report`. Helper `getAutonomy(employee, actionType)` with role defaults from Task 18 config as fallback.
3. Engine gate: in `actions.ts`, before executing any autonomy-governed action under an employee-owned workflow:
   - `act_and_report` → execute (Task 5 guards still apply), stamp `ai_employee_id` on `message_log`/events.
   - `act_with_approval` → insert `pending_actions` with a rendered human-readable `preview` (interpolated body / call target / amount), set the run `waiting` with `resume_at = expires_at` (default 72 h, playbook-overridable). Approval executes the action and resumes the run at the next step; rejection marks the step skipped (`guard:rejected`) and continues or aborts per playbook flag `abort_on_reject`. Expiry behaves like rejection with reason `guard:expired`.
   - `draft_only` → insert `pending_actions` that **cannot** be auto-executed on approval; approving converts it into the drafts/composer flow (SMS/email prefilled in the Task 12 composer; the human sends). Implement by status → `approved` + a deep-link, not a second execution path.
   - Workflows with `ai_employee_id null` (legacy/manual) bypass the ladder but still hit Task 5 guards — unchanged behavior, add a test proving it.
4. Routes under `organizations/[organizationId]/approvals`: list (filter by status/employee), `POST [id]/approve`, `POST [id]/reject` (optional note). The approve path re-checks consent/opt-out and Task 5 guards at execution time, not just at creation time.
5. UI: **Approvals** — a sidebar badge with pending count, a panel (or inbox tab) listing pending actions grouped by employee with preview, one-tap approve/reject, bulk approve per employee. Digest (Task 15) gains a "Waiting on you: N approvals" line with a deep link — link into the app, **no** tokenized approve-from-email (state-changing unauthenticated links are out).
6. Employee settings UI (Team page): per-action autonomy dropdowns with plain-language descriptions ("Sam drafts texts for your approval" / "Sam sends texts and reports back"). Every change writes `ai_employee_autonomy_events`. Surface a small "trust level" indicator per employee (share of action types at `act_and_report`).
7. Ops/analytics: extend the internal ops page with the autonomy funnel (per org: % employees with any `act_and_report`) — this is the activation metric; also expose approval latency (created→decided median).

**Tests:** each level's path for `send_sms` (execute / pending+resume-on-approve / draft-convert); expiry; reject with and without `abort_on_reject`; consent re-checked at approval time (opt-out between creation and approval → refuse); legacy null-employee workflows bypass; autonomy change writes the audit event; RLS on pending_actions.

---

## Task 20 — Scoreboards and the monthly statement

**Goal:** Every employee has a live scoreboard and a monthly statement: what it did, what it earned, what it cost. The anti-churn document.

**Prerequisites:** Tasks 6, 14, 18, 19. Task 24 supplies real seat cost later — use the placeholder cost source in step 4.

**Read first:** `revenue_attribution_v` + `ui_attribution_summary` (Task 14), `usage_monthly_v`, `message_log`, `workflow_runs` (`time_saved_seconds` accounting), `retell_calls`, Task 15 digest templates, Task 3 view conventions.

**Do:**
1. Migration `..._employee_scoreboard.sql` — `security_invoker` views/RPCs:
   - `ui_employee_scoreboard(org_id, company_id, from_ts, to_ts)` → one row per employee: `actions_executed`, `messages_sent` (by channel), `calls_handled` / `calls_missed_recovered` (front_desk/closer), `quotes_chased`, `quote_value_approved_cents` (quotes with this employee's touch before approval — reuse the attribution join pattern; define "touch" = a `message_log` or `retell_calls` row for the contact between quote sent and approved, stamped with the employee), `receivables_recovered_cents` (Task 22 wires this; return 0 until the table exists — guard with `to_regclass`), `time_saved_seconds`, `pending_approvals`, `usage_cost_cents` (that employee's stamped `usage_events`).
   - `ui_employee_statement(org_id, ai_employee_id, month)` → the same plus month-over-month deltas and 3 highlights rows (largest approved quote chased, biggest recovered invoice, busiest day).
2. Attribution stamping: audit that every execution path from Tasks 8/9/19/22 stamps `ai_employee_id` on `message_log`, `workflow_runs`, `usage_events`, and (for closer touches) is joinable to quotes. Fix any gaps found — this task owns stamping completeness.
3. UI:
   - Team card → mini-scoreboard (this month, 3 headline numbers per role: front_desk = calls / booked / after-hours share; closer = chased / approved $ / recovered-from-missed-calls; money = collected $ / outstanding $; office_manager = reports sent).
   - Employee detail drawer → full scoreboard + activity list (their `message_log` + runs) + autonomy settings (Task 19).
   - Dashboard "Your team" strip upgrades from cheap counts to the view.
4. Seat cost source: `getEmployeeSeatCostCents(orgId, role)` in `billing/` returning: Task 24's real Stripe seat price when present; otherwise `null` (UI shows "included"). Never hardcode a dollar figure.
5. Monthly statement: scheduler job type `employee_statements` (Task 9 machinery) on the 1st at 08:00 local per company: **one** email to the owner per company — "Your team's month" with a section per active employee — rendered from `src/server/templates/team-statement.ts`, sent via `notify_owner` plumbing, `message_log`ged, idempotent per `(company_id, month)`. Include: value produced vs seat cost per employee, the 3 highlights, and one suggested autonomy promotion ("Sam's texts have been approved 41/41 times — consider letting him send without approval"), computed from `pending_actions` approval rates. That suggestion is the single most important sentence in the product — only show it above 20 decisions with >95% approval.
6. Internal ops: per-tenant table now shows value-produced vs MRR vs provider cost (ties Task 6 + this).

**Tests:** scoreboard math on a fixture month (calls, messages, a chased-then-approved quote, usage costs) — golden; touch-attribution window edges; statement idempotency; promotion-suggestion thresholds; `to_regclass` guard before Task 22 exists.

---

## Task 21 — Launch The Closer

**Goal:** The Closer ships as a hire-able employee with a persona, owning the follow-up playbooks, present in onboarding, with tone applied to AI-drafted content.

**Prerequisites:** Tasks 18–20, 10, 13.

**Read first:** Task 18 role config, `workflow-engine/recipes/*`, `ai-drafts.ts` + `src/server/ai/claude.ts` (drafting prompts), onboarding step 8, `docs/messaging-compliance.md`.

**Do:**
1. Persona depth for `closer` in role config: tone presets (`friendly | professional | direct`, owner-selectable), signature, a short bio for the Team card, and 3 sample messages per tone (used in UI preview and as few-shot for drafting).
2. Drafting integration: when a `draft_only` Closer action needs body text beyond the playbook template (e.g., reviving a stale lead with context), route through a `draftAsEmployee(employee, context)` helper in `src/server/ai/` that injects persona + tone + the contact's recent thread (from `ui_conversation_thread`) into the prompt (cached system block per Task 6). Zod-validate output; record token usage stamped to the employee.
3. Playbook tuning: `quote-follow-up` and `missed-call-text-back` templates rewritten to use `{{ employee.name }}` and tone variants; `missed-call-text-back` stays `act_and_report`-eligible but respects Task 5 cooldown, with a Task 18 working-hours **exception**: text-back is allowed outside working hours within 5 minutes of the missed call (that's its entire value) — implement as a playbook-level `ignore_working_hours: true` flag, documented.
4. Onboarding: step 8 becomes "Build your team" — Marina (already hired via the phone step) + a Closer hire card with tone picker and autonomy default `act_with_approval`. Skippable.
5. Default-hire policy for existing tenants: do **not** auto-hire; show a one-time dashboard card "Meet Sam" for orgs with ≥5 sent quotes, linking to hire. A1 companies: hire Sam with everything `draft_only` so the owner can watch him work risk-free (seed/script, note in handoff).
6. Empty-state copy across Quotes/CRM references the Closer when not hired ("11 quotes are sitting unanswered — Sam can chase these").

**Tests:** tone variants golden; `draftAsEmployee` validation + usage stamping; out-of-hours text-back allowed only under the flag and cooldown; onboarding hire flow; meet-Sam card threshold.

---

## Task 22 — The Money Person: receivables + collections playbooks

**Goal:** EmpireVu knows who owes the business money and chases it — politely, first-party, escalating, with the owner in the loop by default. Recovered dollars land on Dana's scoreboard.

**Prerequisites:** Tasks 18–20, 8–9, 6; Stripe Connect (`quotes/{connect,checkout,company-stripe}.ts`); Jobber sync optional (degrade gracefully if the org has no Jobber connection).

**Read first:** `quotes/*` (deposit + checkout flows, `company_stripe_customers`), `docs/jobber-integration.md` + `jobber/{client,sync-jobs}.ts` (**confirm what invoice data the sync already pulls or can pull — read the doc, do not guess the Jobber API**), `docs/stripe-quotes.md`, `messaging-compliance.md`.

**Do:**
1. Migration `..._receivables.sql`:
   - `receivables (id, organization_id not null, company_id not null composite-FK, contact_id uuid, source text not null check (source in ('quote_deposit','jobber_invoice','manual','stripe')), external_ref text, description text, amount_cents int not null check (amount_cents > 0), currency text not null default 'cad', due_at timestamptz, status text not null check (status in ('open','partial','paid','written_off','disputed','paused')) default 'open', paid_cents int not null default 0, last_reminder_at timestamptz, escalation_step int not null default 0, payment_link_url text, ai_employee_id, metadata jsonb, created_at, updated_at)` + `unique (organization_id, source, external_ref)` + RLS members select / members insert-update (manual entry is a member action) + index `(organization_id, status, due_at)`.
   - `receivable_events (id, organization_id, receivable_id, event_type, amount_cents, actor_profile_id, ai_employee_id, metadata, created_at)` (audit: reminder_sent, payment_received, escalated, paused, disputed, written_off) + RLS.
2. Population:
   - **Quotes:** approved quote with `deposit_cents > 0` and no successful deposit checkout after N days (config `RECEIVABLE_DEPOSIT_LAG_DAYS`, default 3) → upsert a `quote_deposit` receivable. Paid deposit (existing Stripe webhook path) → mark paid + `receivable_events.payment_received`.
   - **Jobber:** if the org's sync exposes invoices, extend `jobber-sync-worker` to upsert `jobber_invoice` receivables (balance, due date) and update on webhook. If invoices are not available in the current sync scope, create the seam (source enum + upsert function + a `docs/jobber-integration.md` note on the extra OAuth scope needed) and stop there — say so in the handoff.
   - **Manual:** UI + `POST /receivables` for the owner to add any invoice (amount, due date, contact, description).
3. Payment links: `createReceivablePaymentLink(receivableId)` — a Stripe Checkout session on the **company's connected account** (reuse the quote-deposit checkout pattern: destination/on_behalf_of per existing `connect.ts` conventions), success webhook marks paid/partial (idempotent on session id), stores `payment_link_url`. Never store card data; never touch platform-account charges for tenant money.
4. Collection playbooks (owned by `money`, installed on hire, default autonomy `draft_only` per Task 18 — promotion is the owner's explicit act):
   - `deposit-nudge`: quote approved, deposit unpaid → due+0: friendly SMS with link → wait 4d, resume-if-unpaid → email → owner task.
   - `invoice-reminder-ladder`: due+3 gentle SMS ("Hi {{contact.first_name}}, {{employee.name}} from {{company.name}} — invoice {{receivable.description}} for {{receivable.amount | money}} is past due; pay here: {{receivable.payment_link}}") → due+10 firmer email → due+21 final notice (email+SMS) → owner task "call or write off". Frequency-capped: never more than one touch per receivable per 72 h regardless of playbook math (enforce in a guard, not just templates).
   - Every touch: consent check, opt-out honored, `escalate_receivable`/`send_payment_link` autonomy keys consulted, `receivable_events` + `message_log` + scoreboard stamping. `disputed`/`paused` status halts the ladder immediately; an inbound SMS from the contact (Task 11 trigger) pauses the ladder and creates an owner task (`resume_conditions`).
5. New workflow triggers: `receivable.overdue` emitted by the Task 9 scheduler scanning `receivables` daily per company (idempotent per receivable+step), and `receivable.paid` for celebration/reporting.
6. Scoreboard wiring: `receivables_recovered_cents` in `ui_employee_scoreboard` = payments received on receivables whose last reminder before payment was Dana's (window: 14 days) — conservative definition, documented in the view comment; the Task 20 statement highlights it.
7. UI: **Money** screen (`/money`): aging buckets (current / 1–30 / 31–60 / 60+), receivable list with status, ladder position, pause/dispute/write-off actions, manual add, "Dana's queue" (pending approvals filtered to money). Dashboard card: "Outstanding: $X · Recovered this month: $Y".
8. Compliance: update `docs/messaging-compliance.md` with the first-party rules (protocol rule 15), the 72 h frequency cap, and the owner-counsel note. Templates identify the business, the invoice, the amount, and how to pay — nothing else.

**Tests:** receivable lifecycle (open→partial→paid) from mocked Stripe events, idempotent; deposit-lag creation; ladder timing + 72 h cap + inbound-reply pause; dispute halts; payment-link created on the connected account (assert the Stripe call shape against existing checkout tests); recovered-attribution window; degraded mode without Jobber.

---

## Task 23 — The Office Manager: interactive standup + owner commands

**Goal:** The digest becomes a two-way employee: it reports on the team each morning and executes plain-language owner commands with confirmation.

**Prerequisites:** Tasks 15, 11, 18–20.

**Read first:** the digest job + templates, the `twilio` inbound handler + STOP logic (commands must not collide with STOP/START), `ai-employees.ts`, the `pending_actions` service, `src/server/ai/claude.ts`.

**Do:**
1. Re-home the digest under an `office_manager` employee (auto-created `active` for companies with digest enabled; named from role config, owner-editable). Statement emails (Task 20) and digests both send as this employee.
2. Standup content v2: per-employee sections ("Marina: 6 calls, 2 booked, 1 urgent — listen"; "Sam: 3 quotes chased, 1 approved $2,150"; "Dana: sent 2 reminders, collected $890, 4 approvals waiting"), then "Waiting on you: N approvals", then today. SMS ≤ 320 chars with a link; email gets the full version.
3. Owner command channel: inbound SMS **from a verified owner phone** (`companies.owner_phone_e164`, exact match; anyone else's texts are customer messages per Task 11) that is not STOP/START is treated as a command. Pipeline:
   - Claude classifies into a **closed** command set with zod-validated output: `approve_all (employee?)`, `approve_item (index)`, `reject_item (index)`, `pause_employee (name)`, `resume_employee (name)`, `pause_contact_outreach (contact ref, days)`, `send_report (employee?)`, `help`, `unknown`.
   - `unknown` or low confidence → reply "Didn't catch that — reply HELP for what I can do." Never guess.
   - Every state-changing command gets a **confirmation round-trip**: "Pause Sam's outreach to Henderson for 7 days? Reply YES." A pending command row (`office_commands` table: org, company, command jsonb, status pending/confirmed/expired, expires 15 min) holds it; `YES` from the same number executes via the existing services (approvals API, `pauseEmployee`, a new `contact_outreach_pauses (contact_id, until)` honored by the Task 8 send actions and Task 22 ladder). Everything audited to `activity_events`.
   - Numbered references ("approve 2") resolve against the most recent digest/approvals list sent to that owner — persist the mapping with the digest send (`office_commands` metadata), expire with it.
4. Rate/abuse: commands limited to 30/day per company; classification usage stamped to the office_manager on the ledger; command texts never enter customer-facing logs.
5. UI: the Office Manager's Team card shows digest settings (moved from Settings), last standup, command history.

**Tests:** owner-number gating (non-owner text → customer path); STOP precedence; classify→confirm→execute for each command (mock Claude with fixtures); confirmation expiry; numbered-reference resolution against a stale list; outreach pause honored by send actions and the receivables ladder.

---

## Task 24 — Seat billing: hire = subscribe

**Goal:** Employees are priced as seats. Hiring adds a Stripe subscription item; pausing/firing removes it at period end. Existing plans keep working via included seats. Internal orgs exempt.

**Prerequisites:** Tasks 18, 19, 1, 6; existing billing stack (`billing/*`, Stripe webhook, billing worker, reconcile job).

**Read first:** `billing/{config,env,checkout,events,gating}.ts`, `docs/billing.md`, `docs/go-live-phase-1.md`, the subscription-update handling in the billing worker (price→plan mapping), `stripe-org-scoping.md`.

**Do:**
1. Config: `SEAT_ROLES = ['front_desk','closer','money','office_manager']` (dispatcher/marketer reserved). Env: `STRIPE_PRICE_SEAT_FRONT_DESK`, `STRIPE_PRICE_SEAT_CLOSER`, `STRIPE_PRICE_SEAT_MONEY`, `STRIPE_PRICE_SEAT_OFFICE_MANAGER` (+ `.env.example` tags `[web] [billing-worker] [reconcile]`). **No amounts in code.** Plan-included seats map in `billing/config.ts`: `launch → []`, `operate → ['closer','office_manager']`, `front_desk → ['front_desk','closer','money','office_manager']` (mirrors the Task 1 superset fix; **confirm this allocation with the owner in the handoff — it's product policy, flag it**).
2. Migration: prefer deriving entitlements over persisting them: entitled roles = plan-included ∪ roles of active paid subscription items. Persist only what Stripe tells us: extend the existing subscription state storage with a `seat_items jsonb` column (role → {item_id, status}) updated by the billing worker from `customer.subscription.updated` (map price id → role via env, exactly like price→plan today). The reconcile job diffs it nightly.
3. Gating: `orgHasSeat(supabase, orgId, role)` in `gating.ts` (internal → true; else derived entitlement, honoring the existing past_due grace). Enforce at: `hireEmployee` (402 with a checkout URL when missing), employee `status='active'` transitions, and — belt and braces — the Task 19 gate refuses execution for an employee whose seat lapsed (degrade to `draft_only` behavior + a dashboard warning, don't silently kill the workflows; log `seat.lapsed`).
4. Hire flow: Team page "Hire" on an unentitled role → `POST /billing/seats/checkout` creating a Checkout session that **adds the seat item to the existing subscription** (or starts one if the org has none — reuse `createCheckoutSession` patterns); on webhook confirmation the pending hire completes (store intent in a `pending_hires` row or reuse `pending_actions` with a system actor — pick the simpler, justify in the PR). Pause/fire → portal or `DELETE /billing/seats/[role]` removing the item at period end (proration policy: none — document).
5. Scoreboard hookup: `getEmployeeSeatCostCents` (Task 20 stub) now reads the live Stripe price for the role's item.
6. Billing UI: seats section — per-role price (from Stripe, like `listPlanPricing`), included-in-plan badges, hire/release. `docs/billing.md` updated with the seat model and the manual Stripe setup checklist (create 4 prices, set env per service).

**Tests:** entitlement derivation (plan-included, purchased, both, none); hire blocked→checkout→webhook→completed; lapse degrades to draft_only and warns; reconcile flags drift; internal exempt; price→role mapping.

---

## Task 25 — Missed-call audit mode (the sales wedge)

**Goal:** A prospect forwards their line for a week; EmpireVu produces a "here's what you missed and what it was worth" report. Software does the selling.

**Prerequisites:** Tasks 13, 4, 9, 18.

**Read first:** `retell/provision.ts` (Task 13), `retell/lead-adapter.ts` missed-call definition (Task 9), `service_catalog_*` tables, `onboarding_*` tables, `ai/claude.ts`.

**Do:**
1. `companies.mode text check (mode in ('full','audit')) default 'full'` migration + an audit-mode voice profile template: answers with "Thanks for calling {{company.name}} — we can't take your call right now. Please leave your name, number, and what you need." Captures voicemail + transcript; **no** booking, no quoting, no outbound. Calls land in `retell_calls` as usual; leads created with `needs_attention` and tagged `audit`.
2. Audit onboarding: a trimmed wizard path (`/onboarding?mode=audit`): business basics → provision number → forwarding instructions per carrier (static doc page, the big Canadian carriers) → confirm with a test call. Reuse Task 13 steps 1, 3, 6 only. Track in `onboarding_events` with `mode=audit`.
3. Intent + value estimation: a scheduler job (weekly, per audit company) classifies each captured call's transcript against the company's catalog (or a generic trade-services taxonomy when the catalog is empty) → `{intent, matched_service, estimated_value_cents | null, confidence}`. Conservative: value only when a matched service has a price; otherwise count without dollars. Store on the call row (`custom_analysis_data`), stamp AI usage.
4. The report: weekly email (and end-of-audit summary): calls received / after-hours share / top intents / "estimated value of enquiries: $X (based on your listed prices)" with the per-call table (time, caller, ask, est. value), honestly labeled as an estimate. Rendered from a template; CTA = "Hire Marina — she'd have answered all of these" linking to the full onboarding to convert (`companies.mode → 'full'`, keep the number, keep the history — that continuity is the pitch). The one-click conversion path must work.
5. Billing: audit mode is free or a flat trial — implement as a `PLAN_FEATURE_DEFAULTS` `audit` plan (all false except a new `audit_mode` feature) or exempt `mode='audit'` companies from gating with a 14-day expiry (`audit_expires_at`; scheduler pauses the number after, and the final report says so). Pick the simpler; document. Cap audit orgs' minutes via the Task 6 ledger to bound cost.
6. Internal ops: audit funnel (started → number live → report sent → converted).

**Tests:** audit voice profile provisions distinctly; classification golden on fixture transcripts (with/without catalog); value only with priced match; weekly report idempotent; expiry pauses; conversion flips mode and preserves number + calls.

---

## Task 26 — Powered-by + referrals

**Goal:** Every public surface quietly recruits the next tenant; give-a-month/get-a-month closes the loop through Stripe.

**Prerequisites:** Task 1 baseline billing webhook + worker (Task 24 helpful but not required); public quote + booking pages.

**Read first:** `PublicQuotePage.tsx`, `PublicBookingPage.tsx`, `public-service.ts` (what the public payload exposes), billing worker event handling, `organizations.ts` + signup flow (`SignUpPage`, `OnboardingPage`).

**Do:**
1. Migration: `organizations.referral_code text unique` (generated: short, unambiguous alphabet, on org create + backfill), `organizations.referred_by_code text`; `referrals (id, referrer_organization_id, referred_organization_id unique, code, status text check (status in ('signed_up','activated','rewarded')) default 'signed_up', rewarded_at, created_at)` + RLS (each side sees its own rows).
2. Footer: public quote and public booking pages get a small "Powered by EmpireVu — an AI team for your business" link → `APP_BASE_URL/?ref={code}` (the **tenant's** code, so the tenant gets credit). Config: on for all plans by default; a `feature_flags` key `hide_powered_by` can turn it off per org (admin sets it manually for now — no self-serve removal in this task). SMS footers: **do not** add powered-by to SMS (character budget + it's the customer's relationship — decided, documented).
3. Signup: `?ref=` persisted through the auth flow (cookie or signup metadata — check how the SPA carries state through Supabase auth redirects and use the durable option), written to `organizations.referred_by_code` + a `referrals` row on org creation.
4. Reward: when the billing worker processes the referred org's **first successful subscription payment** (`invoice.paid` / equivalent event already handled — hook there), mark `activated`, then apply the coupon `STRIPE_COUPON_REFERRAL_MONTH` (env; created manually in Stripe, doc it) to **both** subscriptions via the API, mark `rewarded`, notify both owners via `notify_owner`. Idempotent; if either subscription can't take the coupon (canceled), skip that side with a logged reason.
5. UI: Settings → "Refer a business": the org's link, copy button, referral list with statuses, months earned.
6. `docs/billing.md` + a new `docs/referrals.md` (mechanics, coupon setup, abuse notes: self-referral blocked by matching Stripe customer email/org owner, one reward per referred org).

**Tests:** code generation uniqueness; ref persistence through signup; reward idempotency + both-sides coupon; self-referral blocked; footer respects the flag; public payload doesn't leak anything new.

---

# Appendices

## Appendix A — Repo map for quick orientation

| Area | Path |
|---|---|
| API routes | `src/app/api/**` (org-scoped under `organizations/[organizationId]/`; `ui/*` = read models; `ops/*` = internal) |
| Auth/org context | `src/server/organizations/context.ts` (`requireOrganizationContext`, `getAuthenticatedUser`) |
| Route wrapper | `src/server/api/route.ts` (`handleRoute`, `parseJsonBody`) |
| Service layer | `src/server/services/**` (`shared.ts` has `TenantServiceContext`, `assertCompanyInOrganization`, `assertContactInOrganization`) |
| Read models | `src/server/services/live-data.ts` (→ views/RPCs after Task 3) |
| Workflow engine | `src/server/services/workflow-engine/{types,actions,conditions,context,definitions,dispatch,matcher,processor}.ts` (+ `guards.ts` Task 5, `recipes/` Task 10) |
| Queue | `workflow-event-jobs.ts`, RPC `claim_workflow_event_jobs`, worker `src/server/workers/workflow-event-worker.ts` |
| Outbound providers | `src/server/outbound/{email,sms,voice,retell-voice}.ts` (fetch-based, no SDKs) |
| Lead intake | `src/server/services/lead-intake/{envelope,hmac,intake,matching,notify,routing}.ts`, `src/app/api/intake/route.ts` |
| Voice | `retell/*`, `telnyx/*`, `company-voice-profiles.ts`, `voice.ts` |
| Quotes | `src/server/services/quotes/*`, public routes `src/app/api/public/quotes/[token]/*`, screen `PublicQuotePage.tsx` |
| Billing | `src/server/services/billing/*`, webhook `src/app/api/webhooks/stripe/*`, worker `billing-event-worker.ts`, job `billing-reconcile.ts` |
| AI | `src/server/ai/{claude,workflow-author}.ts`, services `ai.ts`, `ai-drafts.ts`, `ai-workflows.ts` |
| AI employees | `src/server/services/ai-employees.ts` + `ai-employees/config.ts` (Task 18) |
| Supabase clients | `src/server/supabase/{server,admin,env}.ts` |
| DB types | `src/server/db/database.types.ts` (regenerate via `npm run gen:types`, Task 2) |
| Migrations / rollback / seeds | `supabase/migrations`, `supabase/rollback`, `supabase/seeds` |
| SPA | `src/App.tsx` (routes), `src/screens/*`, `src/components/*`, `src/lib/{api,api-hooks,org-context}.ts*` |
| Tests | `src/test/*.test.ts`, `src/test/setup.ts` |
| Deploy | `railway.json` (web), `railway.worker.json`, `railway.billing-worker.json`, `railway.billing-reconcile.json`, `railway.quote-maintenance.json`, `railway.jobber-sync.json` |

## Appendix B — New schema surface (summary, Phases 1–3)

Phase 1–2: `inbound_webhook_jobs`, `rate_limit_buckets`, `usage_events` (+ `usage_monthly_v`), `intake_keys`, `voice_numbers`, `message_log`, `workflow_schedule_ticks`, `contact_read_state`, `onboarding_progress`, `onboarding_events`, `revenue_attribution_v`, read-model views (`ui_*`), + columns on `contacts` (consent), `companies` (timezone/hours/owner contact/digest), `workflow_runs` (waiting/resume), `retell_calls` (duration/cost).

Phase 3: `ai_employees`, `ai_employee_autonomy_events`, `pending_actions`, `receivables`, `receivable_events`, `office_commands`, `contact_outreach_pauses`, `referrals`, + `ai_employee_id` columns on `workflows/workflow_runs/message_log/retell_calls/quotes/usage_events`, `companies.mode/audit_expires_at`, `organizations.referral_code/referred_by_code`, subscription `seat_items`. All RLS'd per protocol rule 1. Check whether a column already exists (an earlier task may have added it) before adding it.

## Appendix C — Autonomy keys × employees (defaults)

| action_type | front_desk | closer | money | office_manager |
|---|---|---|---|---|
| send_sms | act_and_report (text-back n/a — closer owns it) | act_with_approval | draft_only | act_and_report (owner-facing only) |
| send_email | — | act_with_approval | draft_only | act_and_report (owner-facing only) |
| call_lead | act_and_report (callback on request) | act_with_approval | — | — |
| send_payment_link | — | — | draft_only | — |
| escalate_receivable | — | — | draft_only | — |

Owner-facing messages (`notify_owner`, digests, statements) never require approval — they *are* the reporting.

## Appendix D — Sequencing

- **Phase 1 (0–7) is strictly ordered.** Don't skip ahead; every later task assumes it.
- **Phase 2:** 8 → 9 → 10 in order; 11 → 12 in order; 13 needs 7 + 11; 14–16 are independent after their prerequisites; 17 any time after 13.
- **Phase 3:** 18 → 19 → 20 → 21 is the spine — ship those four before anything else so the frame ("employees with trust levels and scoreboards") exists. 22 (Money) is the biggest single task; give it its own week. 23–26 are independent of each other after 20 and can be reordered against sales needs: 25 first for a prospecting wedge, 24 first if a paying tenant is imminent.
- **Against the December gate** (5 external paying tenants, 4 retained in month 2, onboarding < 2 h, attributable revenue for 3): Tasks 0–7 ≈ weeks 1–4, 8–13 ≈ weeks 5–9, 14–16 + 18–21 ≈ weeks 10–13. Everything in weeks 1–4 is foundation you'd need anyway; everything after is product you can demo.
