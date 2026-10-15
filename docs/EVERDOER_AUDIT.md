# EmpireVu Audit — Phase 0 (Syncoree → EmpireVu)

**Repo:** `syncoree` (to be renamed EmpireVu) · **Date:** 2026-07-05 · **Status:** audit only, **no code changed**.

**Method:** five parallel read-only audits (mission pages, secondary/auth pages, backend API + service surface, workflow engine + worker, auth/security/architecture) cross-checked against the Supabase migrations and seed. Every claim below is traceable to `file:line` in the source.

---

## 0. Executive summary

The repo is in **much better shape than "paused Lovable project" implies**, with three real surprises:

1. **The mission UI already reads live Supabase data.** Dashboard, CRM, Contact detail, Calendar, and Tasks all fetch through the `/ui/*` route layer → `live-data.ts` → real tables. None are mock on the read path. The gaps are **write-side** (inert buttons, one real bug), not "it's all fake."
2. **The workflow engine is fully implemented** — the prior `backend-schema-audit.md` line *"workflow execution is still intentionally unimplemented"* is **stale/false**. Real DB-backed queue, atomic `SKIP LOCKED` job claiming, Railway poller, retries, idempotency, and `workflow_runs`/`activity_events` persistence all work.
3. **There is zero email/notification capability anywhere** — no mail dependency, no mail code, four hard-coded workflow actions none of which send email. The lead-hub mission's notification requirement must be built from scratch.

Two structural liabilities: **no committed deploy topology** (the Vite SPA and Next API are two independent builds with nothing serving them together — a prod cookie/CORS trap), and **zero automated tests on the core CRM loop**.

**Bottom line:** the backend foundation and the read UI are strong enough to build the lead hub on without a rewrite. The work is (a) a serving/architecture decision, (b) foundation fixes + tests, (c) net-new lead intake + email, (d) finishing write-side UI, (e) reseeding to the real A1 org.

---

## 1. Live-vs-mock inventory — every frontend page

Legend: **LIVE** = displayed data from Supabase · **PARTIAL** = some live/some mock · **STUB** = renders but data is hardcoded · **BROKEN/DEAD** = won't render / unused.

### Mission set (the four the mission needs)

| Page | Data source | State | What's missing to be fully live |
|---|---|---|---|
| `Dashboard.tsx` | `/ui/dashboard/summary·activity·automation-impact` via react-query | **LIVE** | Nothing on data. "Quick Actions" are static nav by design. |
| `CRMPage.tsx` | `/ui/crm/contacts` (list, kanban) | **LIVE read / broken write** | **Bug:** `useUpdateContactStage(orgId,"")` called with empty `contactId` (`CRMPage.tsx:278`), and `handleStageChange` drops the per-row id — kanban/list stage change PATCHes an empty id and won't persist. |
| `ContactDetailPage.tsx` | `/ui/crm/contacts/:id` (all tabs) | **LIVE display** | Action buttons (Edit, Take Action, New Booking, New Task, Add Note) have no handlers; wire to existing mutations/hooks. |
| `CalendarPage.tsx` | `/ui/calendar`, `/capacity`, `/bookings/:id` | **LIVE display** | "No-show" button is a silent no-op (validator + client type exclude `no_show`); Day/Month toggles don't change the query range (always weekly). |
| `TasksPage.tsx` | `/ui/tasks`, `/ui/tasks/:id` | **LIVE display + status/create** | Comment box + Send are inert (**no comment-create client/hook exists**); Filter button unwired (params already support status/priority/assignee/overdue). |

### Secondary / ops / auth

| Page | State | Data source | Mission | Recommendation |
|---|---|---|---|---|
| `AutomationsPage.tsx` | LIVE | `/ui/automations/*` + run/test/retry mutations | in-mission | keep; only "Create Workflow" buttons are no-ops |
| `OpsPage.tsx` | LIVE | `/ops/*` (jobs/runs/contacts/tasks/bookings health) | internal (`/internal/ops`, not in nav) | keep off-nav |
| `AppDiagnosticsPage.tsx` | LIVE | `/api/session/context` + dashboard summary | internal (`/internal/diagnostics`) | keep off-nav |
| `OnboardingPage.tsx` | LIVE | `POST /organizations` + `/companies` | in-mission | keep + wire |
| `SettingsPage.tsx` | **STUB** | hardcoded (`defaultValue="Thinker Holdings"`); Save inert; 4/6 tabs empty | in-mission | wire org/company/members; honest empty for rest |
| `TeamPage.tsx` | **STUB** | hardcoded `team` array; "Invite" inert; fake "4 companies" | adjacent | stub-empty or wire to `/members` (orphaned route) |
| `FilesPage.tsx` | **STUB** | hardcoded `files` array | **out-of-mission** | stub-empty state or remove from nav |
| `ProjectsPage.tsx` | **STUB** | hardcoded `projects` array | **out-of-mission** | stub-empty state or remove from nav |
| `Index.tsx` | **DEAD** | Lovable `/placeholder.svg`; **not imported anywhere** (`Dashboard` is `/`) | none | **delete** |
| `NotFound.tsx` | LIVE | static 404 | infra | keep |
| `SignInPage` / `SignUpPage` / `ForgotPasswordPage` / `PhoneAuthPage` / `OAuthCallbackPage` | LIVE | real Supabase auth (password, OAuth Google, phone OTP, reset) | auth infra | keep |
| `UpdatePasswordPage.tsx` | **PARTIAL** | `updateUser` is real, but expects `?token_hash&type=recovery` while reset redirects to `/auth/callback` — **a route that doesn't exist** | auth infra | fix redirect/route mismatch |
| `OAuthConsentPage.tsx` | ORPHAN | decorative "success" screen; nothing routes to `/oauth/consent`; no token exchange | auth infra | delete or leave dormant |

**Nav today:** Dashboard, Calendar, Tasks, CRM, Projects, Automations, Files, Team, Settings. (Ops/Diagnostics are `/internal/*`, off-nav.)

**Note — duplicate context providers:** `org-context.tsx` (`useOrg`, used by all mission pages) and `app-context.tsx` (`useAppContext`, unused by them) coexist. `app-context.tsx` looks legacy; verify + remove in Phase 1.

---

## 2. Backend surface

Three route tiers under `src/app/api/organizations/[organizationId]/`:
- **bare entity** routes (`/contacts`, `/bookings`, `/tasks`, …) — the **write** path the UI uses.
- **`/ui/*`** — denormalized read-models for the mission UI (`live-data.ts`).
- **`/ops/*`** — internal ops console (`OpsPage` only).

**Complete & consumed:** all `/ui/*` read-models; `POST /contacts`, `PATCH /contacts/:id` (stage/owner), `POST /bookings`, `PATCH /bookings/:id`, `POST /tasks`, `PATCH /tasks/:id`, `/session/context`, all `/ops/*`.

**Orphaned (exist, no UI caller):**
- `POST /companies` + `createCompany` — **no create-company UI**. Since the contact dialog blocks submit without a `companyId` (`CRMPage.tsx:117`), a fresh org with zero companies **cannot create a contact from the UI**.
- `/comments` GET/POST — service complete, comments appear inside traces, but **no client fn/hook** → users can't post comments (this backs the inert Tasks/Contact comment boxes). Largest "built but unreachable" gap.
- `/activity-events` GET/POST, `/members`, bare `GET /contacts·/bookings·/tasks` (UI uses richer `/ui/*`).

**Core loop — create contact → CRM list → activity event: FULLY WIRED.**
`createContact` (`contacts.ts:82`) inserts the row, then **synchronously** `emitActivityEventAndDispatch(eventType:"contact.created")` (`contacts.ts:104`) which persists the `activity_events` row **independently of any workflow match**, then conditionally enqueues a workflow job. The hook invalidates `["crm","contacts"]` and the list refetches. No break. Bookings/tasks follow the same pattern. **Asymmetry:** `createCompany` emits `company.created` via `createActivityEvent` but **does not dispatch** a workflow (`companies.ts:66`).

**Tests:** **zero coverage of the core CRM loop.** Only `example.test.ts` (trivial), `slugify.test.ts`, and two workflow files. No route/service/live-data tests.

**Performance note (not a break):** every `/ui/*` read-model does `listAllRows` — pulls whole org tables into memory and joins in JS (`live-data.ts:651-667`). Fine at A1's volume; won't scale to large tenants. Defer.

---

## 3. Workflow engine assessment

- **Triggers (5):** `contact.created`, `contact.stage_changed`, `booking.created`, `booking.completed`, `task.completed` (`workflow-engine/types.ts:3-9`).
- **Actions (4, hard-limited):** `create_task`, `assign_user`, `update_status`, `create_activity_event` (`actions.ts:89-282`). Unknown types silently ignored (no default case). Supports `{{ field }}` interpolation + `time_saved_seconds`.
- **Email/notification: NONE.** No `resend`/`nodemailer`/`sendgrid`/SMTP in `package.json`; no mail code in `src/server`; no email action. **Phase 2 must add a provider + a `send_email` action from scratch.**
- **Execution: real.** `processor.ts` loads the event, matches active workflows (`matcher.ts`), evaluates AND-only conditions (`conditions.ts`), creates a `workflow_runs` row, executes real service mutations, writes a `workflow.executed` activity event, and records failure reasons. Dry-run (`run-test`) projects without writing; `run-now` executes. Idempotent via unique `(org, workflow, trigger_event)` short-circuit.
- **Queue + worker:** `emitActivityEventAndDispatch` → `enqueueWorkflowEventJob` (unique `(org, activity_event_id)`, `max_attempts` 5). Worker `worker:workflow-events` (`tsx src/server/workers/workflow-event-worker.ts`) is an infinite poller (default 2 s) claiming jobs via the `claim_workflow_event_jobs` RPC (`FOR UPDATE SKIP LOCKED`, stale-reaper at 900 s). **Requires `SUPABASE_SERVICE_ROLE_KEY` + `NEXT_PUBLIC_SUPABASE_URL`** (throws if absent).

**Implication for the lead hub:** the trigger path (`contact.created`) already fires on contact creation, so a "Lead Intake" workflow *can* drive notification — **once a `send_email` action exists**. Decision needed (see §6): notify via a new engine action (async, retried, worker-dependent) vs a direct Resend call in the intake route (synchronous, no worker dependency). The engine adds robustness but couples notification to the worker being deployed; a direct send matches the legacy hub's proven pattern.

---

## 4. Architecture decision — recommend **consolidate to a single-origin web runtime**

**Facts:**
- Next 14 is used **only as an API server** (route handlers; no Next pages/SSR). The SPA is a separate Vite static bundle (`index.html` + `src/main.tsx`, React Router).
- **Dev:** Vite `:8080` + Next `:3000`, bridged one-way by Vite's `/api → :3000` proxy (`vite.config.ts:14-19`). Auth is Supabase **cookies**, so same-origin (via proxy) makes `credentials:"include"` work.
- **Prod:** two independent builds (`vite build`, `next build`); **nothing serves them together**; the dev proxy doesn't exist; SPA↔API binding relies on `VITE_API_BASE_URL` baked at build (`api.ts:32-34`). **No deploy config is committed** (no `railway.*`, `Procfile`, `Dockerfile`, `vercel.json`, `.env*`).
- **The trap:** if the SPA and API land on different origins in prod, cookie auth needs `SameSite=None`+`Secure`+CORS, none configured. A misconfigured `VITE_API_BASE_URL=""` silently points the SPA at its own origin and 404s the API.

**Recommendation: one Railway "web" service running Next that also serves the built SPA (static assets + SPA fallback for non-`/api` routes), plus one Railway "worker" service running the poller.** Rationale — this is the *ship-fastest-without-traps* option:
- **Single origin** ⇒ cookie auth, RLS context, and CORS all "just work"; no `SameSite`/CORS surface to get wrong.
- **Bounded rework:** no page rewrite — the React-Router SPA stays as-is; we only add static-serve + fallback to the Next runtime and a build step that hands Next the Vite output. (Est. **M**.)
- **Worker stays isolated** so the service-role key doesn't share the web container and the poller can restart independently.

**Alternative (keep hybrid, two origins):** viable but carries the cookie/CORS/`SameSite` burden and the uncommitted-topology risk — more moving parts and more ways to silently break auth. Not recommended.

**⚠️ Open question (stop-and-ask):** how is EmpireVu deployed **today**? Nothing is committed, so I can't tell if it's already two Railway services, one, or not deployed yet. The consolidation plan above assumes we can define the prod topology cleanly; if there's an existing Railway setup I must not disrupt, I need its shape before Phase 1.

---

## 5. Auth & security state

- **Session:** Supabase Auth via `@supabase/ssr`; session in **cookies**; routes read the user server-side (`getAuthenticatedUser` → `supabase.auth.getUser()`), then `requireOrganizationContext` verifies `organization_memberships` under RLS. localStorage holds only UI state (active org/company id). Real flows: password, Google OAuth, phone OTP, reset/update.
- **RLS: complete.** Every core table — `organizations`, `organization_memberships`, `companies`, `company_memberships`, `contacts`, `bookings`, `tasks`, `activity_events`, `comments`, `workflows`, `workflow_runs`, `workflow_event_jobs`, `profiles` — has RLS enabled + CRUD policies, based on `is_organization_member` / `is_organization_admin`. **No table missing coverage.**
- **Service-role key: SAFE.** `SUPABASE_SERVICE_ROLE_KEY` / admin client is invoked in **exactly one place — the worker CLI**. No API route imports it; request paths run entirely on the RLS-enforced cookie/anon context.

**Scary things (prioritized):**
1. **Uncommitted prod topology + cookie auth** (see §4) — most likely place for a silent auth break. *Fix in Phase 1 via consolidation.*
2. **All writes are org-member-level**, not role- or company-scoped: any `member` can CRUD every company/contact/booking/task in the org. `company_memberships` exists but isn't used to scope rows. *Acceptable for a single-owner org now; note before adding staff logins.*
3. **No import boundary around the admin client** — nothing stops a future route from importing `createSupabaseAdminClient` and bypassing tenancy. Safe today by convention only. *Add a lint/boundary guard (S).*
4. **Enum drift** — `contact_stage` (v1: lead/qualified/customer/inactive/archived) vs later `contact_stage_v2` (lead/qualified/active/closed), etc. Confirm which is authoritative before mapping lead stages (S).

---

## 6. Prioritized completion plan

Effort: **S** ≤ half-day · **M** ~1–2 days · **L** ~3–5 days.

### MUST — core mission (CRM + lead hub + tasks/calendar for the A1 org)

| # | Item | Phase | Effort |
|---|---|---|---|
| 1 | **Architecture: consolidate to single-origin** (Next serves API + SPA) + worker service; commit the deploy config | 1 | M |
| 2 | Rename Syncoree→EmpireVu (package/UI/README/seed); delete dead `Index.tsx`; remove legacy `app-context.tsx` if unused | 1 | S |
| 3 | Fix foundation bugs blocking the loop: CRM empty-`contactId` stage bug; auth recovery redirect (`/auth/callback`) | 1 | S |
| 4 | **Add create-company UI** (unblocks contact creation for a fresh org) | 1 | S–M |
| 5 | **Test baseline**: existing green + typecheck + core-loop smoke test (create contact → CRM list → activity event) | 1 | M |
| 6 | **Canonical lead envelope + `docs/LEAD_SCHEMA.md`** (schemaVersion 1; `sourceSite` required; normalize message/notes + boat fields; lineItems) | 2 | S–M |
| 7 | **Intake endpoint** (HMAC-authed, never-drop): parse → contacts + activity_events (+ bookings for `formType:booking`); `raw_leads` table for invalid/unknown with `schemaValid:false`; always notify + return success | 2 | L |
| 8 | **Customer matching** (normalized email + last-10 phone) → link to contact + cross-company activity event; cross-brand flag; degrade gracefully | 2 | M |
| 9 | **Notification: add Resend** + `send_email` workflow action (or direct intake send — decision below); brand-prefixed subject, lead ID, returning-customer enrichment, line items; email failure never fails intake | 2 | M |
| 10 | **Spoke fan-out (additive)**: extend shared `lead-pipeline` (storage repo) to multi-destination; bring Care's `crm-webhook.ts` onto it; dual-send legacy hub **+** EmpireVu in both sites; legacy behavior byte-identical | 2 | M–L |
| 11 | **Reseed A1 family**: org "A1 Group" + A1 Marine Care / A1 Marine Storage / A1 Coatings; me as owner; verify company scoping end-to-end | 3 | S |
| 12 | **Finish mission write-side UI**: ContactDetail buttons, Tasks comment box (needs comment client/hook), Calendar `no_show`/views, company filter + cross-brand flags | 4 | M |
| 13 | **Honest non-mission pages**: stub-empty or de-nav Files/Projects/Team; make Settings honest | 4 | S |
| 14 | **E2E matrix + `docs/EMPIREVU_RUNBOOK.md`** incl. cutover criteria | 5 | M |

### CAN WAIT
- `live-data.ts` in-memory joins → SQL views/RPC (perf at scale).
- RLS role/company granularity (needed only when non-owner logins arrive).
- DELETE + general-edit endpoints for entities; `/members` wiring.
- Optional backfill of historical leads from spoke logs (Phase 3, **ask first**).

### DELETE rather than finish
- `Index.tsx` (dead), `OAuthConsentPage.tsx` (orphan), `app-context.tsx` (legacy dup — verify).
- Mock data paths in Files/Projects/Team (replace with honest empty states, don't wire fake data).

---

## Appendix — lead envelope → Supabase mapping (Phase 2 preview)

| Envelope field | EmpireVu destination |
|---|---|
| `source` (brand-form tag), `sourceSite` (**required**) | `contacts.metadata_json` / `activity_events.metadata_json`; drives company routing |
| `formType` (quote·contact·booking) | activity `event_type`; `booking` also creates a `bookings` row |
| contact block (email/phone/name) | `contacts` (matched or created), normalized keys for matching |
| message/notes (single field) | `contacts.notes` / activity metadata |
| `lineItems[]` (desc/qty/unitPriceCents) | activity/booking `metadata_json` (Jobber-shaped, preserved) |
| boat/asset block | `contacts.metadata_json` (normalize the 3 spoke variants) |
| `meta` (site/page/UTM) | `activity_events.metadata_json` |
| invalid / unparseable | **new `raw_leads` table** (`schemaValid:false`, full raw payload) — never dropped |

**Decisions needed before Phase 1** — see the two open questions in the accompanying report: (1) architecture sign-off (consolidate vs hybrid) and current Railway topology; (2) notification via engine `send_email` action vs direct intake send.
