# Done-for-you CrankLeads

## Concierge console

An operator-only console where Marcus (or a closer) finishes setup **for** a buyer without
signing in as them. Every change is written server-side with the service role, scoped to the
buyer's org + its own company, and audited.

**Who can use it.** `OPERATOR_EMAILS` (web service env): comma-separated, case-insensitive list of
operator emails. A user is an operator only if they are signed in (cookie or `Authorization:
Bearer`, verified with Supabase Auth like every other route), their email is **confirmed**, and it
is on the list. Everyone else — signed out, unconfirmed, not listed, or the variable unset — gets a
plain **404** from every concierge route, and the SPA renders the normal not-found page, so the
console's existence isn't revealed. `GET /api/session/context` returns `isOperator`; the sidebar
shows a **Concierge** entry only when it's true. `OPS_ADMIN_TOKEN` routes are unchanged.
Helper: `requireOperator(request)` in `src/server/services/concierge/auth.ts`.

**Screens.** `/concierge` — CrankLeads orgs (`platform_brand = 'crankleads'`), newest first, filter
chips *Needs a call / Setting up / Live*, tap-to-call/text, tier, hours since purchase with an SLA
badge (green < 12h, amber 12–24h, red > 24h) and progress dots. `/concierge/:orgId` — a *Call
script* header (owner, phone, what's missing in plain words incl. the exact forwarding code for
their line type + carrier), action buttons with confirmations, editable business facts, price
table, activity log (operator actions + automatic reminder sends) and automations.

"Needs a call" = not live and (≥ 24h since purchase, or quick setup `failed`, or no text-back/AI
number). The number counts as failed when it's missing an hour after purchase (it's bought at
purchase) or the operator's last buy attempt failed. "Live" comes from the setup checklist
evaluator (`loadSetupChecklist`), so it follows whatever rules that module defines.

**API** (all operator-only, all 404 otherwise):

| Route | |
|---|---|
| `GET /api/concierge/accounts` | list + setup state per company |
| `GET /api/concierge/accounts/:orgId[?companyId=]` | detail (facts, services, automations, activity, follow-ups, call script, registered actions) |
| `GET /api/concierge/accounts/:orgId/actions` | registered actions |
| `POST /api/concierge/accounts/:orgId/actions` | `{ action, companyId?, input }` |

Any org can be opened by explicit id. A `companyId` is honoured only if it belongs to that org
(else 404 — no write, no audit); by default the org's CrankLeads company is used.

**Actions** (`src/server/services/concierge/actions.ts`, a registry `name → { label, schema, run }`):
`update_business_facts` (website, hours — `{summary}` or per-day `{mon:{open,close}}`, service area,
review link, owner phone, business-line kind + carrier, https logo URL), `set_service_price`
(set/clear price, on/off — an unpriced service can't be switched on; clearing switches it off),
`add_service`, `provision_text_back_number` (reuses `provisionMissedCallCatcher`; area code from
the business/owner phone), `run_forwarding_test` (reuses `startOwnerForwardingTest` and its rate
limit / calling hours), `resend_welcome_email` (reuses `resendWelcomeEmail`), `add_note`.
Every input is zod-validated (strict — unknown keys are rejected). The `operator_actions` row
(`operator_email`, org, company, action, `detail.input`) is written **before** the action runs — if
it can't be written nothing happens — and then updated with `status: ok|failed`, the message or
error, and before/after where useful.

Other parts add actions with `registerConciergeAction({ name, label, schema, run })` (e.g. resend
quick-setup link, re-run enrichment, regenerate site, send forwarding text); they show up in the
console as confirm-and-run buttons and go through the same scoping + audit. `run(ctx, input)` gets
`ctx.admin`, `ctx.tenant` (service-role context pinned to the org), `ctx.organizationId`,
`ctx.companyId`, `ctx.company`, `ctx.purchase`, `ctx.operator`; filter every write by
`organization_id` + company.

Sanctioned service-role surfaces: `services/concierge/accounts.ts` and `actions.ts`, behind
`requireOperator`. No migration (uses `operator_actions` from `20261008100000_done_for_you.sql`).
Tests: `src/test/concierge.test.ts`.
