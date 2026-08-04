# Billing (Stripe) — Phase 1

The Stripe subscription-billing layer for EmpireVu/Tilotto. **Phase 1 is plumbing
only, in Stripe TEST MODE**: a subscription can be created, upgraded, downgraded,
and canceled against an `organization`, with local state always kept correct. No
customer-facing UI ships here, and gating is **not** yet wired into existing
routes (that is Phase 2).

House tenants (`plan = 'internal'`, the default for every existing org — the A1
brands, boatnames, blairspm) are **exempt from all billing enforcement and
gating** and are untouched by any of this.

---

## ✅ Manual setup checklist

Do these in order. Nothing here is automated — the app never writes prices or
creates the webhook endpoint for you.

### In the Stripe Dashboard (Test mode)

- [ ] Create a **Product + recurring Price** for each plan: `launch`, `operate`,
      `front_desk`. Copy each **Price id** (`price_...`).
- [ ] (Optional) Create a one-time **setup-fee Price** per plan if you charge one.
      Copy those ids too.
- [ ] Create a **Webhook endpoint** → URL `https://<your-app-host>/api/webhooks/stripe`.
      Subscribe at least to: `checkout.session.completed`, `invoice.paid`,
      `invoice.payment_failed`, `customer.subscription.updated`,
      `customer.subscription.deleted`.
- [ ] Copy the endpoint's **Signing secret** (`whsec_...`).
- [ ] Copy your **Secret key** (`sk_test_...`) and **Publishable key** (`pk_test_...`).

### In Supabase

- [ ] Apply the migration `supabase/migrations/20260804120000_add_billing.sql`
      (SQL editor — Railway does not run migrations; see the runbook).
- [ ] (Recommended) Run `supabase/tests/verify-billing.sql` to confirm the schema
      + RLS landed correctly.

### In Railway

- [ ] Set the env vars below on the **web** service: `STRIPE_SECRET_KEY`,
      `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_*` (+ setup
      fees), `BILLING_PAST_DUE_GRACE_DAYS`.
- [ ] Create a **new worker service** from `railway.billing-worker.json`
      (start command `npm run worker:billing-events`). Give it `STRIPE_SECRET_KEY`,
      the Supabase URL + **service-role key**, and the `STRIPE_PRICE_*` vars.
- [ ] Create a **cron service** from `railway.billing-reconcile.json`
      (`npm run job:billing-reconcile`, nightly). Same env as the worker. Set/confirm
      the cron schedule in the Railway service settings.

> **Secrets discipline:** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are
> server-only — never give them a `VITE_`/`NEXT_PUBLIC_` prefix, never log them,
> never import them client-side. Only `STRIPE_PUBLISHABLE_KEY` is client-safe.

---

## Environment variables

| Var | Where | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | web, billing worker, reconcile | Server-only secret. |
| `STRIPE_WEBHOOK_SECRET` | web | Endpoint signing secret (`whsec_...`). |
| `STRIPE_PUBLISHABLE_KEY` | (client, Phase 2) | Client-safe; unused in Phase 1. |
| `STRIPE_PRICE_LAUNCH` / `_OPERATE` / `_FRONT_DESK` | web, workers | Recurring Price ids. |
| `STRIPE_SETUP_FEE_LAUNCH` / `_OPERATE` / `_FRONT_DESK` | web | Optional one-time fee Price ids. |
| `BILLING_PAST_DUE_GRACE_DAYS` | web (gating), workers | Default `7`. |
| `BILLING_EVENT_WORKER_ID` / `_BATCH_SIZE` / `_POLL_MS` / `_STALE_AFTER_SECONDS` | billing worker | Tuning; defaults `pid` / `10` / `2000` / `900`. |
| `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` | web, workers | Existing; the workers need service-role. |
| `APP_BASE_URL` | web | Used to build Checkout/Portal return URLs. |

See `.env.example` for the annotated list.

---

## How it works (event flow)

Durable-write-first, then process idempotently off a Postgres queue — the same
philosophy as the lead-intake `raw_leads` log and the `workflow_event_jobs`
queue.

```mermaid
flowchart LR
  S[Stripe] -- "POST /api/webhooks/stripe" --> W[Webhook route]
  W -- "verify signature (raw body)" --> W
  W -- "record_billing_event RPC (atomic)" --> L[(billing_events\nledger)]
  W -- "same txn" --> Q[(billing_event_jobs\nqueue)]
  W -- "200 fast" --> S
  BW[billing-event-worker] -- "claim_billing_event_jobs\nFOR UPDATE SKIP LOCKED" --> Q
  BW -- "apply transition" --> O[(organizations\n+ subscriptions)]
  BW -- "processed_at" --> L
```

1. **Webhook** (`src/app/api/webhooks/stripe/route.ts`) reads the raw body,
   verifies the `Stripe-Signature` (bad → `400`, no write), then calls the
   `record_billing_event` RPC. That RPC inserts the ledger row
   `on conflict (stripe_event_id) do nothing` **and** enqueues a job **in one
   transaction**. Returns `200` fast (duplicate delivery = no-op, still `200`).
   A durable-write failure → `500` so Stripe retries.
2. **Worker** (`src/server/workers/billing-event-worker.ts`) polls
   `claim_billing_event_jobs`, then `processBillingEventJob`
   (`src/server/services/billing/events.ts`) resolves the org via
   `stripe_customer_id`, applies the transition to `organizations` +
   `subscriptions` idempotently, backfills the ledger's `organization_id`, and
   stamps `processed_at`.
3. **Unresolvable events** (unknown customer) → the job **dead-letters**
   (`status = 'failed'`), the ledger row is **kept** (`processed_at` stays null),
   and it's logged loudly for manual review. Never discarded.

**Idempotency:** dedup on receipt via the unique `stripe_event_id`; transitions
are upserts keyed on `stripe_subscription_id`, so replaying an event yields
identical state.

**Gating** (`src/server/services/billing/gating.ts`): `orgCan` / `orgLimit`.
`internal` → always true/unlimited. Otherwise the subscription must be healthy
(`active`/`trialing`, or `past_due` within `current_period_end + grace`), and a
`feature_flags` row (if any) overrides the plan default. Server-side only.

Plan → feature access lives in one config module:
`src/server/services/billing/config.ts`.

---

## Local development

```bash
# 1. Forward Stripe test-mode events to your local webhook:
stripe listen --forward-to localhost:3000/api/webhooks/stripe
#    -> prints a whsec_... ; put it in .env.local as STRIPE_WEBHOOK_SECRET
```

```bash
# 2. Run the Next API and the billing worker (two terminals):
npm run dev:next
```

```bash
npm run worker:billing-events
```

Trigger events with `stripe trigger <event>` or by completing a test Checkout.

---

## Test-mode end-to-end verification (phase exit criteria)

Use a **non-internal** test org (set its `plan` to something other than
`internal`, or create a fresh org, so gating actually applies). Auth as a member
of that org for the internal routes.

1. **Create** — `POST /api/organizations/{orgId}/billing/checkout` with
   `{ "plan": "launch" }`. Open the returned `url`, pay with test card
   `4242 4242 4242 4242`. Stripe fires `checkout.session.completed` + `invoice.paid`.
   → org `subscription_status = active`, a `subscriptions` row exists, and
   `GET /api/organizations/{orgId}/billing` shows the gating map.
2. **Upgrade / downgrade** — `POST .../billing/portal`, open the portal, switch
   plan. → `customer.subscription.updated` → local `plan` updates.
3. **Fail payment** — `stripe trigger invoice.payment_failed` (or use a failing
   test card). → `subscription_status = past_due`. Paid features stay on until
   `current_period_end + BILLING_PAST_DUE_GRACE_DAYS`, then gate off.
4. **Cancel** — cancel in the portal. → `customer.subscription.deleted` →
   `subscription_status = canceled`, `plan` retained for history, paid features
   gated off.
5. **House-tenant check** — for an `internal` org, `orgCan` returns true for every
   feature and no webhook touches it.
6. **Idempotency** — re-send any event from the Stripe dashboard → duplicate is a
   no-op and state is unchanged.

---

## Applying / rolling back the migration

Migrations are applied **by hand** in the Supabase SQL editor (see
`docs/EMPIREVU_RUNBOOK.md`). For billing:

- **Up:** paste `supabase/migrations/20260804120000_add_billing.sql`.
- **Verify:** run `supabase/tests/verify-billing.sql` (schema + RLS + payload
  column-privilege assertions; RAISEs on any failure).
- **Down:** paste `supabase/rollback/20260804120000_add_billing.down.sql`. This is
  **rollback-only** and is not part of the forward migration set — never apply it
  on a normal deploy.

Clean up/down/up = apply up → down → up again with no errors.

---

## Operational notes

- **Two Railway workers now**: the existing `workflow-event` worker and the new
  `billing-event` worker are separate services so billing throughput/failures are
  isolated from workflow processing.
- **Dead-letters**: a `billing_event_jobs` row with `status = 'failed'` is the
  dead-letter. Inspect `last_error`; the underlying `billing_events` row is intact,
  so the event can be re-driven after fixing the cause (e.g. linking the customer).
- **Reconciliation**: `npm run job:billing-reconcile` (nightly) lists Stripe
  active/past_due subscriptions and logs any drift vs local state. **Read-only —
  it alerts, it never auto-corrects.** Non-zero exit on mismatch.
- **API version**: pinned to the SDK's `LatestApiVersion`
  (`src/server/services/billing/stripe.ts`); bump it when upgrading `stripe`.
