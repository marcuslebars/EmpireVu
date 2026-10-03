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

**No Docker? Use `npm run gen:types:remote`** — it loads `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN` from a git-ignored `.env.local` (see `.env.example`) and runs remote mode, so you don't pass them each time and never need a local Supabase/Docker. Plain `npm run gen:types` still works when those vars are already exported or the local stack is up.

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
- **Also durable-first:** `/api/twilio/sms/inbound` (`provider='twilio'`), `/api/twilio/voice/inbound` (`twilio_voice`) and `/api/twilio/voice/recording` (`twilio_voicemail`) — see the missed-call catcher section.
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
| `POST /api/public/forms/[formKey]` (website lead forms) | 8 / 10 min per IP (keyed on `trustedClientIp` — rightmost public `x-forwarded-for` hop, which Railway's edge appends; the other routes still key on the forgeable first hop — migrate them as a follow-up) **and** 100 / hour per form; plus a streamed 16 KB body cap, Origin / `allowed_origins`, honeypot + timing, Turnstile — see [website-forms.md](website-forms.md) |
| `GET /api/public/forms/[formKey]` | 60 / 10 min per IP |
| `POST /api/public/quotes/[token]/{approve,reprice}` | 20 / 10 min per token |
| `POST /api/intake`, `/api/retell/*`, `/api/telnyx/*`, `/api/jobber/webhook`, `/api/webhooks/stripe/*` | 600 / min per IP (signed; DoS backstop via `enforceWebhookBackstop`) |

**2) Cloudflare Turnstile + honeypot + timing** on the booking, waitlist and website lead forms (`src/server/services/turnstile.ts`). Client renders the widget when `VITE_TURNSTILE_SITE_KEY` is set; the server verifies with `TURNSTILE_SECRET_KEY`. **Fail-open until configured:** unset secret → skip with a warning (every env), so shipping never breaks a live form; once set, a missing/invalid token is rejected. A hidden `website` honeypot and a `formStartedAt` timestamp (submit < 3 s ⇒ bot) run with no network call. ⚠️ The waitlist form lives in the **empirevu-site** repo (empirevu.com); render its widget + post `turnstileToken` there BEFORE setting the shared `TURNSTILE_SECRET_KEY`, or waitlist signups will be rejected. Not applied to the hosted quote page (the token is the auth).

**3) Paid-action guard** (`src/server/services/workflow-engine/guards.ts`). Before a `call_lead` (and later `send_sms`) workflow action runs, `assertPaidActionAllowed` checks whether the trigger was *unauthenticated-sourced* (`activity_event.actor_user_id is null` and `metadata.source ∈ {public_booking, public_form, waitlist, intake_unverified}` — signed intake stamps `intake`, which is trusted and exempt). If so it refuses when the same phone (last-10) already got an outbound call from this company in 24 h (`guard:cooldown`), or the company hit its daily cap of unauthenticated-sourced calls (`guard:daily_cap`; default **20**, overridable per org via `feature_flags.limit_value` for feature `public_outbound_calls_daily`). A refusal is recorded as the workflow run's `failure_reason` (logged at *warn*, not as a crash) — visible in Automations. Authenticated triggers pass straight through. Placed calls are tagged (`contact.call_placed` metadata `triggerSource`) so the cap can count them; owner-initiated calls are untagged and never count. **SMS (`send_sms` to a contact) from an unauthenticated source** has its own leg, counted from `message_log` (outbound, `sent`): per-destination-phone cooldown (`UNAUTH_SMS_COOLDOWN_HOURS`, default 24 → `guard:sms_cooldown`) and a per-company 24 h cap (`UNAUTH_SMS_DAILY_CAP`, default 100, counts all the company's sent SMS → `guard:sms_daily_cap`). Website-form triggers whose Turnstile check did not actually verify carry `paidActionsVerified=false` and get **no** paid actions (`guard:unverified`) — **set `TURNSTILE_SECRET_KEY` in production for instant-reply on forms**.

All 429s and guard refusals are logged with org/company ids and **no PII** (no IP, no phone).

## Usage ledger, minutes metering & AI cost controls
Every metered thing is recorded once, rolled up monthly, enforced via `orgLimit`, and shown per tenant. Migration `20260904160000_usage_ledger.sql`.
- **`usage_events`** is the append-only ledger — kinds `voice_minutes`, `sms_sent`/`sms_received`, `email_sent`, `ai_input_tokens`/`ai_output_tokens`/`ai_cache_read_tokens`; each row carries `quantity`, `unit`, `cost_cents`, `provider`, `provider_ref`. `unique (provider, provider_ref, kind)` makes recording **idempotent** (a duplicate webhook / retry counts once). RLS: members read, **no insert policy** — writes go through `services/usage.ts` (service role). `usage_monthly_v` (`security_invoker`) rolls it up by org × company × **month (America/Toronto)** × kind.
- **Written from:** the Retell ingest (`voice_minutes = duration_ms/60000`, `cost_cents` from Retell's `call_cost.combined_cost`, ref = `call_id`; `retell_calls` also stores `duration_ms`/`start_timestamp`/`end_timestamp`/`call_cost_cents`/`cost_breakdown`); customer SMS/email sends (`ai-drafts`, ref = Twilio SID / Resend id); and each Claude call (`ai/claude.ts`, `ai/workflow-author.ts` → tokens from `response.usage`, ref = `response.id`, cost from env-overridable per-MTok rates in `ai/pricing.ts`). All writes are **best-effort** — metering never fails a customer send or an AI call.
- **Limits:** `front_desk.marina_reception = 500` monthly voice minutes (`PLAN_FEATURE_LIMITS`). `orgUsageRemaining` = `orgLimit` − month-to-date usage (`usage_monthly_v`); `requireFeature("marina_reception")` now also throws `UsageCapExceeded` (→ **402** in `handleRoute`) when remaining ≤ 0, covering `/voice/call` and the contact quick-call. The `call_lead` automation is capped via the Task 5 guard (`guard:usage_cap`). **Inbound Marina calls are never refused** — they only record usage; crossing 500 shows as an *overage* in the billing panel (Stripe overage billing is a later task).
- **AI cost controls:** the static system prompt in both Claude call sites is sent as a cached block (`cache_control: ephemeral`); model per surface is env-selectable (`AI_MODEL_DRAFTS`, `AI_MODEL_WORKFLOWS`, default `claude-opus-4-8`) so drafts can move to a smaller model without a deploy.
- **Visibility:** `/settings/billing` shows a **This month** panel (minutes vs cap, SMS, emails, AI cost estimate) via `GET /api/organizations/{id}/usage/monthly` (member RLS). Internal per-tenant **cost vs MRR** is `GET /api/ops/tenant-costs` — token-gated by `OPS_ADMIN_TOKEN` (JSON or `?format=csv`), service-role, cross-tenant; MRR = the tenant's plan list price from Stripe (`listPlanPricing`). *(Delivered as a token-gated endpoint rather than an in-app page — the app has no platform-admin identity; a platform-admin UI can consume it later.)*

## Multi-tenant edges (intake keys, voice numbers)
A brand-new tenant receives web leads and Marina calls with **no env change or deploy** — see [tenant-provisioning.md](tenant-provisioning.md) for the onboarding + A1 cutover checklists. Migration `20260904180000_multitenant_edges.sql`.
- **`intake_keys`** — per-tenant keys (only the sha256 stored; the full key is shown once). `/api/intake` reads `x-empirevu-key`: the org+company are pinned by the key row and the body HMAC is keyed by the key itself. No key header → legacy mode (HMAC by `LEAD_INTAKE_SECRET`, `sourceSite`→company), which logs `intake.legacy_auth_used` once/hour/sourceSite until cutover. `sourceSite` is a free-text tag in both modes.
- **`voice_numbers`** — supersedes `telnyx_numbers` (rows copied in; old table kept one release, deprecated). Retell inbound resolves by dialled number → agent id → legacy `RETELL_SOURCE_SITE`; Telnyx reads `provider='telnyx'`. Managed in Settings → **Integrations** (create/revoke keys, add/deactivate numbers — admin only).
- The legacy path is intact this release (do not remove `LEAD_INTAKE_SECRET` until every spoke stops logging `intake.legacy_auth_used`).

## Website lead forms (hosted page + embed)
Non-technical owners get a lead form without a developer — see [website-forms.md](website-forms.md). Migration `20261002120000_public_lead_forms.sql` (**apply in the SQL Editor with the deploy** — until it exists, creating a form and every `/api/public/forms/*` call fail on the missing table; nothing else is affected). No new env vars.
- **`public_form_keys`** — publishable, company-scoped `evpk_…` keys (stored as-is; NOT secrets — contrast `intake_keys`), `form_type` (`quote`/`contact`), `allowed_origins` (empty = any site), `active`, `last_used_at`. RLS: members read, admins manage. Managed in onboarding → Website leads and Settings → Integrations → **Website lead form** (`/api/organizations/{orgId}/public-forms`).
- **`GET/POST /api/public/forms/{formKey}`** — public, unauthenticated. The tenant is pinned from the key row; POST runs the abuse layers above, builds a schemaVersion-1 envelope (`source: "public_form"`, `sourceSite` = company slug or `embed`) and calls `handleLeadIntake` with the key's org/company pinned and `workflowTrigger: { source: "public_form" }` — a NEW contact dispatches `contact.created` (owner alert / instant-reply recipes), stamped so the paid-action guard throttles it. GET returns display-safe fields only (name, logo, `brand_reply_phone`, brand colour, catalog labels — no prices).
- **Hosted page** `/f/{formKey}` (SPA, public) and **embed script** `/embed/v1.js` (static file in `public/embed/`, copied into the build by `npm run build`). Smoke: open `https://APP/f/<key>` signed-out → the form renders; `Invoke-WebRequest https://APP/embed/v1.js` → 200.
- Revoke = Settings → "Turn this form off" (`active=false`): link + all embeds 404 immediately.

## Workflow messaging actions (send_sms / send_email / notify_owner)
Workflows can text/email customers and alert the owner (Task 8). Migration `20260905120000_messaging_consent.sql`; compliance in [messaging-compliance.md](messaging-compliance.md).
- **Consent (CASL):** every customer message is consent-checked server-side (`checkConsent`) — opted-out, no consent, or expired (implied consent lasts 6 months) → the send is refused and logged `blocked`. Owner alerts and literal recipients are not consent-checked. The first SMS to a contact appends `Reply STOP to opt out` (inbound STOP processing is Task 11).
- **Templates:** bodies/subjects interpolate `{{ contact.first_name }}`, `{{ company.name }}`, `{{ booking.scheduled_for | date }}`, `{{ company.booking_url }}`, `{{ quote.public_url }}`, plus `date`/`time`/`money` filters (business timezone). A contact with no name (intake stores the placeholder first name "Lead") renders `{{ contact.first_name }}` as **"there"**, so a phone-only caller gets "Hi there," — never "Hi Lead," (`withGreetingName` in `workflow-engine/context.ts`). Authored in Automations → the action editor; the **Run test** button previews the interpolated body (dry-run, no send).
- **Records:** every outbound message writes `message_log` (audit) and `usage_events` (metering, Task 6). SMS also passes the Task 5 paid-action guard. Sends emit `contact.sms_sent` / `contact.email_sent` **emit-only** (no workflow re-trigger — loop-safe). Owner routing (`resolveOwnerContacts`): `companies.owner_email`/`owner_phone_e164`, then `OWNER_EMAIL` **only for the house org** (`organizations.plan = 'internal'` or slug = `LEAD_INTAKE_ORG_SLUG`, i.e. A1, which keeps its original order), then the org owner's profile email, then an admin's. A tenant org never falls back to `OWNER_EMAIL`, because that would send its alerts to the platform inbox.

## Workflow delays, schedules & new triggers (Task 9)
Sequences (“wait 2 days, then…”) and time-based triggers (“every day at 08:00”, “24 h before the booking”) run on the **existing** worker + queue — no new service. Migration `20260905140000_workflow_scheduling.sql`.

- **`wait` action** `{ duration: "2d"|"4h"|"30m" }` **or** `{ until: "booking.scheduled_for - 24h" }` (a field on the triggering record ± a duration; a past time resumes immediately). Optional `resume_conditions` (same shape as trigger conditions): re-checked on resume, and if they no longer hold the sequence **stops** (e.g. stop the nudge once the customer books). The processor runs actions sequentially; on a `wait` it persists `current_step_index` + `resume_at`, flips the run to **`waiting`**, and returns. Time math lives in `workflow-engine/timing.ts` (pure, unit-tested incl. an America/Toronto DST golden).
- **Resume:** each worker tick calls `claim_waiting_workflow_runs` (RPC, `FOR UPDATE SKIP LOCKED`; the `waiting → running` flip *is* the claim, plus a stale-lock reclaim) and resumes each run from `current_step_index`, rebuilding the original event context from `trigger_event_id`. The `(status, resume_at)` index is deliberately **non-partial** (a partial index can't reference the freshly-added `'waiting'` enum value in the same migration).
- **Scheduler** (a job *inside* the worker, throttled to `WORKFLOW_SCHEDULER_INTERVAL_MS`, default 60 s — `scheduler.ts`):
  - **`schedule.daily`** → per-workflow `workflow_schedule_ticks` rows (`unique(workflow_id, scheduled_for)` + `ON CONFLICT DO NOTHING` = fires **exactly once per slot**, even across worker restarts). Local time from `companies.timezone` (new column, falls back to `BUSINESS_TIMEZONE`, then `America/Toronto`); `definition.schedule.daily_time` (default `09:00`).
  - **Entity scans**, deduped by existing `activity_events` so each fires once: `booking.upcoming` (N h before `scheduled_for`, `definition.schedule.hours_before`, default 24), `quote.expiring` (24 h before `valid_until`, unapproved; anchored to the contact/company with `metadata.quoteId` since `quote` isn't a trace entity), `contact.stale` (no activity in `stale_days`, default 7, while `stage = lead`).
- **New event triggers** emitted from the service layer (all via `emitActivityEventAndDispatch`, best-effort — a trigger emission never fails the operation that produced it): `call.missed` / `call.completed` / `call.urgent` (Retell ingest — see [retell-integration.md](retell-integration.md) for the missed/completed rule; `call.missed` is also emitted by the no-AI [missed-call catcher](missed-call-catcher.md), metadata `source='missed_call_catcher'`), `quote.sent` / `quote.viewed` (first view) / `quote.approved`, `booking.cancelled` / `booking.no_show` (on status transition). `call.*` and `quote.*` anchor to the contact (else company).
- **UI:** the Automations trigger picker lists all new triggers; the action editor has a **Wait / delay** step (fixed delay or `until`); the run list shows a **waiting** badge with the resume time.

## Recipe library + AI author grounding (Task 10)
Every new company gets a set of proven automations on day one, and the AI author proposes from them. Migration `20260905160000_company_review_url.sql` (adds `companies.brand_review_url`, exposed to templates as `{{ company.review_url }}` like `booking_url`).

- **Recipes** live in `src/server/services/workflow-engine/recipes/` — one file per recipe exporting a typed `WorkflowDefinition` + metadata (`slug`, `name`, `description`, `default_status`, `requires: ('sms'|'email'|'voice')[]`). Shipped set: `missed-call-text-back`, `new-lead-owner-alert`, `quote-follow-up`, `booking-reminder`, `stale-lead-nudge`, `review-request` (draft), `no-show-recovery` (draft), `urgent-call-escalation`. `quote-follow-up`'s resume conditions gate on the **contact's stage** (`lead`/`qualified`), not quote view/approval — quote.* events anchor to the contact (Task 9), so contact stage is the live "customer acted" signal available on resume.
- **installRecipes(ctx, companyId, { only?, forceDraftCustomerFacing? })** — idempotent via `workflows.slug` (a recipe already present is skipped; slug uniqueness is enforced in code, not the DB). A recipe whose `requires` channel isn't configured (`isSmsSendConfigured` / `isEmailSendConfigured` / `isVoiceConfigured`) installs as **draft** with a `_disabled_reason` stamped in the definition JSON. Called (best-effort) from `createCompany`, and from `POST /api/organizations/{orgId}/workflows/recipes/install`; `GET …/workflows/recipes?companyId=` lists the catalog annotated with installed/blocked state for the Recipes UI.
- **AI author** (`ai/workflow-author.ts`): the recipe definitions are compiled into few-shot examples inside the **cached** system prompt (derived from `ALL_RECIPES`, so they can't drift). The proposal schema now covers the v2 messaging + `wait` actions and every supported trigger; `suggestWorkflows` still drops any proposal that fails `parseWorkflowDefinition`, so an accepted suggestion always compiles.
- **Automations UI:** a **Recipes** section (install / preview / customize; each card shows `estimated_time_saved_seconds`). Customizing opens the installed workflow. The workflow editor now preserves the `schedule` block on save so editing a scheduled recipe doesn't strip its timing.
- **Seed existing tenants:** `npm run job:seed-a1-recipes` (defaults to org slug `LEAD_INTAKE_ORG_SLUG` = `a1-group`; pass `-- --org <slug>` for another). Backfills companies that predate the createCompany hook, seeding every customer-texting recipe as a **draft** so no real customer is texted before the owner reviews and switches it on.

## Inbound SMS + Realtime (Task 11)
Customers can reply, STOP works, and the UI updates live. Migration `20260906120000_realtime_publication.sql` adds `activity_events` + `message_log` to the `supabase_realtime` publication (idempotent DO-block).

- **Webhook:** `POST /api/twilio/sms/inbound` verifies `X-Twilio-Signature` (HMAC-SHA1 over the exact URL + sorted params with `TWILIO_AUTH_TOKEN` — `services/twilio/signature.ts`, **fails closed**), then is durable-first: it enqueues `inbound_webhook_jobs (provider='twilio', external_id=MessageSid)` and returns an empty TwiML `<Response/>`. The worker's `handleInboundSms` drains it.
  - **Signed URL:** Twilio signs the URL configured on the number. Behind the proxy that isn't `request.url`, so the route rebuilds it from `APP_BASE_URL` + path, or uses `TWILIO_INBOUND_SMS_URL` if set. If your webhook is configured with a query string, set `TWILIO_INBOUND_SMS_URL` to the exact value.
- **Worker handler** (`services/twilio/inbound-sms.ts`, service-role): resolves the company by `To` via `voice_numbers` (`provider='twilio'`, `active`) — **add a `voice_numbers` row with `provider='twilio'` for each SMS number**, or inbound SMS to it dead-letters as a failed job. Matches the contact by `From` last-10 within that company (creates one with `consent_source='inbound_sms'` + `sms_consent_at` if none; `contact.created` is **not** dispatched, so it doesn't double-notify). Writes `message_log direction='inbound'`, records `usage_events sms_received`, and is idempotent by MessageSid.
  - **Keywords:** `STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT` → set `sms_opt_out_at`, emit `contact.sms_opted_out`, **no** `contact.sms_received` (never trigger an auto-reply off an opt-out). `START/YES/UNSTOP` → clear opt-out + set `sms_consent_at`, emit `contact.sms_opted_in`. Any other message emits **`contact.sms_received`** (a workflow trigger) — and any auto-reply a workflow sends is still consent-checked in `deliverMessage`, so an opted-out sender can't be texted.
- **`contact.sms_received` is a workflow trigger** (in the Automations picker as "Customer texts back") so "customer replied → notify owner + task" works and quote/booking sequences can abort via `resume_conditions`.
- **Realtime:** `useOrgRealtime(orgId)` (mounted in `AppLayout`) subscribes to INSERTs on `activity_events` + `message_log` filtered by `organization_id` and invalidates the `dashboard` / `crm` / `automations,jobs` query families, so the dashboard, activity feed, open contact, and inbox refetch instantly. `AutomationNotifier` toasts on `contact.sms_received` and `call.missed`.
  - **RLS gating (how verified):** the browser subscribes with the authenticated anon client, and Supabase Realtime Postgres Changes enforces each table's RLS SELECT policy per subscriber — `activity_events_org_members_select` / `message_log_org_members_select` both restrict to org members. **Verified** two ways: (1) an automated test asserts both tables have RLS enabled with member-only SELECT policies and that the hook filters by `organization_id`; (2) manual two-account check — sign in as a member of Org A in one browser and a member of Org B (not A) in another, insert an `activity_events` row for Org A, and confirm only A's browser receives the event (B's subscription gets nothing). Re-run this after any change to those RLS policies.

## Missed-call catcher (no AI) — Catch plan
Missed-call text-back for a business **without** the AI receptionist. Full write-up: [missed-call-catcher.md](missed-call-catcher.md). Migration `20261002130000_missed_call_catcher.sql` (rollback in `supabase/rollback/`).
- **Webhooks:** `POST /api/twilio/voice/inbound` (catcher number's Voice URL) and `POST /api/twilio/voice/recording?event=action|status|transcription` (TwiML callbacks). Both verify `X-Twilio-Signature` (same `services/twilio/signature.ts`, signed URL rebuilt from `TWILIO_WEBHOOK_BASE_URL` → `APP_BASE_URL` + path + query), then are **durable-first** into `inbound_webhook_jobs` (`provider='twilio_voice'`, `external_id=CallSid`; `provider='twilio_voicemail'`, `external_id=recording:<RecordingSid>` / `transcription:<TranscriptionSid>`) before answering. The voice route answers with greeting + `<Record>` TwiML; an unknown called number gets an empty `<Response/>` (job kept). A persist failure returns 500.
- **Worker** (same workflow-event worker): `handleMissedCall` → `missed_calls` row → the shared lead intake (pinned tenant) → `call.missed` via `emitActivityEventAndDispatch` (the unchanged `missed-call-text-back` recipe sends the SMS); repeat callers inside `MISSED_CALL_TEXTBACK_WINDOW_MINUTES` are recorded emit-only. `handleVoicemail` stores the recording/transcript, adds `call.voicemail` (push) and emails the owner.
- **Tenant routing:** `voice_numbers` now allows `provider='twilio'` (previously blocked by the check constraint — so the "add a twilio row for each SMS number" step above was impossible until this migration) and a `mode` column (`ai_receptionist` default | `missed_call_catcher` | `sms_only`). The voice webhook only resolves `mode='missed_call_catcher'` rows.
- **Sending number:** `deliverMessage` sends SMS from the company's own active Twilio number (catcher first), falling back to `TWILIO_FROM_NUMBER`. Companies without a Twilio row are unchanged (A1 unaffected).
- **Twilio numbers are provisioning-only:** the manual voice-numbers API stays `retell`/`telnyx`; provisioning refuses `TWILIO_FROM_NUMBER`, numbers with a `voice_numbers` row in any other org/company, numbers tagged for another company, and (attach) untagged numbers that already have webhooks — all checked before any Twilio webhook change.
- **Provisioning:** `POST /api/organizations/{orgId}/missed-call-catcher` (owner/admin) buys by area code or attaches an account number, sets Voice + Messaging webhooks, writes `voice_numbers`, installs the text-back recipe; idempotent. `GET …?companyId=` returns the number + carrier forwarding codes. Wizard: Phone step → "Missed-call catcher (no AI)".
- **Env:** `TWILIO_WEBHOOK_BASE_URL` (web, optional), `MISSED_CALL_TEXTBACK_WINDOW_MINUTES` (worker, default 10), `MISSED_CALL_VOICEMAIL_MAX_SECONDS` (web, default 120), `MISSED_CALL_TRANSCRIBE` (web, default off), `TWILIO_SAY_VOICE` (web, default `Polly.Joanna`), `TWILIO_NUMBER_COUNTRY` (web, default `CA`). Existing `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` must be on the **web** service for provisioning + signature checks.

## Unified conversation inbox (Task 12)
One place to see and answer everything per contact and org-wide. Migration `20260906170000_conversation_inbox.sql`; **no `database.types.ts`-affecting table besides `contact_read_state`** (the views/function are hand-typed to match — re-run `gen:types` to confirm no drift).

- **Decomposition (own commit, no behavior change):** `ContactDetailPage.tsx` (1,583 lines) split into `src/components/contact/{Header,Timeline,QuotesPanel,BookingsPanel,TasksPanel,AiDraftPanel,VoicePanel}.tsx` (+ `config.ts`), page-level state lifted into `src/hooks/useContactDetail.ts`. The small comments/financials/workflows/notes tab bodies stay inline in the slim orchestrator.
- **Read models** (security_invoker, Task 3 convention):
  - `ui_conversation_thread(p_org_id, p_contact_id, p_before_ts, p_limit)` — keyset-paginated (`occurred_at < before`, newest-first, `limit`) UNION of `message_log`, `retell_calls` (summary + transcript in metadata), contact.*/quote.* `activity_events` (the SMS message-emit markers are excluded — `message_log` carries those), `ai_drafts`, and `raw_leads`.
  - `ui_inbox_v` — one row per contact with a conversation: `last_inbound_at` / `last_outbound_at` / `last_activity_at`, `needs_reply` (last inbound newer than last outbound), `unread` (last inbound after this user's `contact_read_state.last_read_at`, joined on `auth.uid()`), `channel`, `snippet`, `search_text`. Sort `needs_reply desc, last_activity_at desc`; filter by `company_id`. The `needs_reply`/`unread`/thread-order semantics are also encoded as unit-tested pure helpers in `src/lib/inbox-utils.ts`.
- **`/inbox` screen** (nav): left list from `ui_inbox_v`; right pane is the contact thread + a composer. Email and SMS both send through `POST /api/organizations/{orgId}/contacts/{contactId}/messages` → `deliverMessage` (consent + `message_log`); SMS is feature-gated (`sms_sequences`), email is not; a consent refusal returns `{status:"blocked", reason}` (HTTP 200) so the composer explains why nothing went out. The AI-drafted email flow remains in the contact's AI tab. Call rows expand to the Marina summary + transcript and a "Call with Marina" quick-call (`VoicePanel`).
- **Read-state per user:** `contact_read_state (organization_id, contact_id, profile_id, last_read_at)`, RLS self-only (`profile_id = auth.uid()`), upserted via `POST /api/organizations/{orgId}/inbox/{contactId}/read` when a conversation is opened.
- **The contact Timeline** now reads `ui_conversation_thread` too, so the CRM contact page and the inbox share one source of truth.
- **Realtime (Task 11)** keeps both panes live: `useOrgRealtime` now also invalidates the `inbox` query family on `activity_events` / `message_log` inserts.
## Self-serve onboarding wizard (Task 13)
A stranger goes from signup to a working Marina number + website lead form in under ~20 minutes, unassisted; every step provisions something real and is instrumented. Migration `20260907120000_onboarding.sql` (`onboarding_progress`, `onboarding_events`, `companies.hours`/`service_area`, and the public `branding` Storage bucket).

- **Wizard** `/onboarding` (`src/screens/onboarding/OnboardingWizard.tsx`, outside AppLayout): resumable from server state (`GET …/onboarding/progress` returns per-step rows + a `nextStep` resume hint). Steps: **Business** (company profile + branding; logo → `branding` bucket via a service-role upload behind the authed route), **Services** (paste a URL → server fetches + strips the page → Claude drafts `service_catalog_items` with prices blank unless stated; edit/confirm before insert; AI usage metered), **Phone** (`retell/provision.ts` creates/updates a Retell LLM + agent from the company + catalog and purchases/attaches a number with the non-deprecated weighted `inbound_agents` binding; idempotent via the ids stored in the phone step's progress data; writes `voice_numbers`), **Payments** (existing Connect onboarding + status poll), **Website leads** ("Create your form" → hosted link + copy-paste embed snippet with Wix/Squarespace/WordPress/GoDaddy steps + "Send a test lead" through the real public endpoint — see [website-forms.md](website-forms.md); the old intake-key snippet stays behind "Advanced: server-to-server"), **Test call** (call the number; the Task 11 realtime activity feed marks it done when a `call.*` event lands), **Team** (invitations), **Recipes** (Task 10 toggles → install).
- **Instrumentation:** every step start/complete/error → `onboarding_events`. Internal funnel (started/completed + median time-to-complete per step, cross-tenant) at token-gated `GET /api/ops/onboarding-funnel` and surfaced on the in-app **Ops page** (paste `OPS_ADMIN_TOKEN`). This is how the time-to-live gate gets proven.
- **Dashboard** shows a checklist card linking back to `/onboarding` until all 8 steps are complete.
- **Retell provisioning** was built against the live docs (create/update `retell-llm`, `agent`, `phone-number` at `https://api.retellai.com`). The one field to confirm against your account on the first real provision is the agent binding `agent_version: "latest"`. Needs `RETELL_API_KEY` on the web service; secrets never reach the client. Tests mock the Retell client (never call the real API).

## Industry starter packs
Versioned, price-less starter packs per trade (`src/server/services/packs/*`: property-maintenance-snow, landscaping, roofing, hvac-plumbing, marine, general-contractor) that a new company gets in the wizard's Services step or Settings → Industry pack. Migration `20261002140000_industry_packs.sql` adds `companies.industry_pack` (jsonb: id, version, appliedAt, recipes). Routes (owner/admin only, RLS client, no service role): `GET …/industry-packs?companyId=`, `POST …/industry-packs/apply`, `PATCH …/industry-packs/prices`. Pack-created catalog items start **price-less and inactive** until priced. The Phone step appends the pack's receptionist notes to the prompt (`buildReceptionistPrompt(ctx, packNotes)`). No new env vars. See [industry-packs.md](industry-packs.md) for the operator's 30-minute install checklist.

## Service-role (sanctioned) surfaces
`createSupabaseAdminClient()` (service role, bypasses RLS) is used only where a request has no forgeable RLS identity, each carrying a `SANCTIONED EXCEPTION` header comment (convention #2): lead-intake, public-booking, telnyx, retell, quotes (public/checkout/connect), billing, jobber, waitlist, invitations, the workers/jobs (including **`job:monthly-scorecard`**, which reads every company with the service role and filters each query by that company's own `organization_id` + `company_id`), **`/api/health`** (aggregate queue counts only), the **rate limiter** (`services/rate-limit.ts`), the **usage ledger** (`services/usage.ts` — writes `usage_events`, which has no insert policy), the **internal cost report** (`/api/ops/tenant-costs` — cross-tenant aggregates, token-gated), **Marina's phone tools** (`services/retell/tools/*` and `services/retell/caller-lookup.ts` — Retell has no session; the tenant is resolved from the call's dialled number / agent id, never the tool arguments — see [marina-tools.md](marina-tools.md)), the **inbound-SMS handler** (`services/twilio/inbound-sms.ts` — Twilio has no session; the tenant is resolved by the receiving number via `voice_numbers`), the **onboarding logo upload** (`services/onboarding-storage.ts` — writes the `branding` bucket behind the authed org-member route), the **missed-call catcher** (`services/twilio/missed-call.ts`, used by `/api/twilio/voice/inbound`, `/api/twilio/voice/recording` and the inbound-webhook worker — Twilio has no session; requests are signature-verified and the tenant is resolved by the CALLED number via `voice_numbers` (`provider='twilio'`, `mode='missed_call_catcher'`), voicemail callbacks via the `missed_calls` row of the same CallSid; plus `findVoiceNumberOwner`, the cross-org ownership lookup catcher provisioning uses so one tenant can't claim another's — or the shared `TWILIO_FROM_NUMBER` — number), the **website lead forms** (`services/lead-intake/public-forms.ts` — the public form endpoint has no session; the tenant is resolved from the publishable `public_form_keys` row, never the body; reads display-safe company fields + catalog labels only), and the **onboarding funnel** (`/api/ops/onboarding-funnel` — cross-tenant `onboarding_events` aggregates, token-gated). `SUPABASE_SERVICE_ROLE_KEY` stays on the web service.

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
| `TWILIO_WEBHOOK_BASE_URL` | *(optional)* Public origin Twilio calls for the missed-call catcher webhooks; default `APP_BASE_URL`. See [missed-call-catcher.md](missed-call-catcher.md) |
| `MISSED_CALL_VOICEMAIL_MAX_SECONDS` / `MISSED_CALL_TRANSCRIBE` / `TWILIO_SAY_VOICE` / `TWILIO_NUMBER_COUNTRY` | *(optional)* Missed-call catcher greeting/voicemail/number-purchase settings (defaults 120 / off / `Polly.Joanna` / `CA`) |
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
Second Railway service, same repo. Start `npm run worker:workflow-events`. Env: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (+ optional `WORKFLOW_EVENT_WORKER_POLL_MS`/`_BATCH_SIZE`/`_STALE_AFTER_SECONDS`/`_ID`, and `WORKFLOW_SCHEDULER_INTERVAL_MS` default 60 000). No volume. Until it runs, workflow jobs queue but don't execute — fine, since intake writes + notifies directly. **The same process also drains `inbound_webhook_jobs`** (Retell/Jobber/Twilio SMS + missed-call catcher voice/voicemail — the catcher's text-back speed is bounded by `WORKFLOW_EVENT_WORKER_POLL_MS`; it also needs `TWILIO_*` for the `send_sms` text-back and may set `MISSED_CALL_TEXTBACK_WINDOW_MINUTES`) each tick — see [Durable-first inbound webhooks](#durable-first-inbound-webhooks) — so once inbound webhooks are live this service must be deployed for calls/events to be processed (they persist safely either way). **It also resumes `waiting` workflow runs and runs the scheduler** (Task 9 — daily ticks + booking/quote/contact scans; the mobile push digest; and the owner daily digest — SMS/email, per company, Task 15, see [docs/owner-digest.md](owner-digest.md)); without the worker, `wait` steps, time-based triggers, and the morning digests never fire (they persist safely and resume once it's up).

## Monthly scorecard cron service
A separate Railway **cron** service sends each client company's owner last month's results scorecard. See [docs/monthly-scorecard.md](monthly-scorecard.md).

1. Railway → New service → same repo → Settings → **Config-as-code path** `railway.monthly-scorecard.json`. That file pins build `npm run build`, start `npm run job:monthly-scorecard`, restart `NEVER`, and cron `0 13 1 * *` (13:00 UTC on the 1st).
2. Env (service tag `[monthly-scorecard]`): `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `OUTBOUND_FROM_EMAIL` (or `LEAD_FROM_EMAIL`), and `APP_BASE_URL` (for the "See your full results" link). Optional: `OUTBOUND_REPLY_TO`, `BUSINESS_TIMEZONE`, and **`PLATFORM_BRAND_NAME`** (new; the sender display name and footer brand, default `CrankLeads`).
3. Apply `supabase/migrations/20261002150000_monthly_scorecard.sql` before the first run. The scorecard **never** emails `OWNER_EMAIL`. It goes to `companies.owner_email`, then the org's owner/admin. A company with neither is skipped (`no_email`), so set `owner_email` on companies that should receive it.
4. Before the first real run, preview it. In PowerShell with the env loaded, run `npm run job:monthly-scorecard -- --dry-run`. A dry run writes and sends nothing.

The job is idempotent per (company, month). Re-running is safe, and a failed send retries on the next run. Manual re-send: `npm run job:monthly-scorecard -- --company <id> --month YYYY-MM --force`. Opt a company out on **Reports → Monthly results** (owner/admin toggle) or by setting `companies.monthly_scorecard = '{"enabled": false}'`. A non-zero exit means at least one send failed (check the run logs for `[monthly-scorecard] failed`).

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
| `20261002120000_public_lead_forms.sql` | Website lead forms: the `public_form_keys` table behind `/api/public/forms/*`, `/f/:key` and `/embed/v1.js` | Plain DDL; paste as-is. Verify: `select count(*) from public_form_keys;` returns `0` |
| `20261002140000_industry_packs.sql` | Industry starter packs: `companies.industry_pack` | Plain DDL (additive). Until applied, applying a pack fails on the company update. Rollback: `supabase/rollback/20261002140000_industry_packs.down.sql` |
| `20261002150000_monthly_scorecard.sql` | Monthly results scorecard: `companies.monthly_scorecard`, `monthly_scorecard_sends`, `monthly_scorecard_notes` (RLS) | Plain DDL. Apply before the first `[monthly-scorecard]` cron run and before deploying `/reports/monthly`. Rollback: `supabase/rollback/20261002150000_monthly_scorecard.down.sql` |

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
