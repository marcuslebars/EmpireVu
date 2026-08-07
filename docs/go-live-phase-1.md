# Phase 1 go-live — Stripe billing (test mode)

Ordered runbook to bring the Phase 1 billing layer live in **Stripe test mode**.
Deep reference lives in [billing.md](billing.md); this is the do-these-in-order
checklist. Phase 1 ships **no customer-facing UI** and wires gating into **no**
existing routes — house tenants (`plan = 'internal'`) stay fully exempt.

> This file was added in the `phase-1-billing` branch alongside the billing work.

## Service topology (ground truth)

Four Railway services deploy from this one repo; each reads a specific config file
(**Service Settings → Config-as-Code → "Railway Config File"**). A service left on
the default `railway.json` runs the **web** start command, so the path must be set
explicitly for every non-web service.

| Service | Config file | Start command | Status |
|---|---|---|---|
| Web app | `railway.json` | `npm run start` (`next start`) | pre-existing |
| Workflow worker | `railway.worker.json` | `npm run worker:workflow-events` | pre-existing — **unchanged** |
| **Billing worker** | `railway.billing-worker.json` | `npm run worker:billing-events` | **new (Phase 1)** |
| **Reconcile cron** | `railway.billing-reconcile.json` | `npm run job:billing-reconcile` (`0 8 * * *`) | **new (Phase 1)** |

There is no Procfile/nixpacks/Dockerfile — Railway builds via RAILPACK + the
`buildCommand`/`startCommand` in each JSON.

## Per-service env vars

Legend: ✅ required · ➕ recommended · ○ optional · — not needed.

| Var | web | billing-worker | reconcile | workflow-worker |
|---|:--:|:--:|:--:|:--:|
| `STRIPE_SECRET_KEY` | ✅ | — | ✅ | — |
| `STRIPE_WEBHOOK_SECRET` | ✅ | — | — | — |
| `STRIPE_PUBLISHABLE_KEY` | ○ (Phase 2) | — | — | — |
| `STRIPE_PRICE_LAUNCH` / `_OPERATE` / `_FRONT_DESK` | ✅ | ✅ | ➕ | — |
| `STRIPE_SETUP_FEE_*` | ○ | — | — | — |
| `BILLING_PAST_DUE_GRACE_DAYS` (def 7) | ○ | — | — | — |
| `BILLING_EVENT_WORKER_ID` / `_BATCH_SIZE` / `_POLL_MS` / `_STALE_AFTER_SECONDS` | — | ○ | — | — |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | ✅ | ✅ | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ✅ | ✅ | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `_PUBLISHABLE_KEY`) | ✅ | — | — | — |
| `APP_BASE_URL` | ✅ | — | — | — |

- The **billing worker has no `STRIPE_SECRET_KEY`** — it only reads the stored event payload and writes Postgres; it never constructs a Stripe client. The **reconcile** job does (`stripe.subscriptions.list`).
- **`BILLING_PAST_DUE_GRACE_DAYS` is web-only** — read by `getPastDueGraceDays()` → `orgCan`/`orgLimit` (`billing/gating.ts`), whose only caller is the web `GET .../billing` route.

## Steps

### 1. Stripe dashboard (test mode)
- [ ] Product + recurring Price for `launch`, `operate`, `front_desk` → copy each `price_...`.
- [ ] (Optional) one-time setup-fee Prices → copy ids.
- [ ] Webhook endpoint → `https://<web-host>/api/webhooks/stripe`, events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` → copy `whsec_...`.
- [ ] Copy the `sk_test_...` secret key and `pk_test_...` publishable key.

### 2. Supabase
- [ ] Apply `supabase/migrations/20260804120000_add_billing.sql` in the SQL editor (Railway does not run migrations).
- [ ] Run `supabase/tests/verify-billing.sql` → expect `ALL AUTOMATED BILLING SCHEMA/RLS CHECKS PASSED`.
- [ ] Rollback if ever needed: `supabase/rollback/20260804120000_add_billing.down.sql`.

### 3. Railway
- [ ] Set web-service env (table above).
- [ ] Create the **billing worker** service, config file `railway.billing-worker.json`, set its env.
- [ ] Create the **reconcile cron** service, config file `railway.billing-reconcile.json`, set its env, confirm schedule.
- [ ] Leave the **workflow worker unchanged** (no billing env).
- [ ] Deploy (merge to `main` triggers the web auto-deploy).

### 4. Verify end-to-end (exit criteria)
Against a **non-`internal`** test org, authed as a member:
1. **Create** — `POST /api/organizations/{orgId}/billing/checkout` `{"plan":"launch"}`, pay with `4242 4242 4242 4242` → org `active`, `subscriptions` row; `GET .../billing` shows the gating map.
2. **Upgrade/downgrade** — `POST .../billing/portal`, switch plan → local `plan` updates (needs `STRIPE_PRICE_*` on the billing worker).
3. **Fail payment** — `stripe trigger invoice.payment_failed` → `past_due`; features gate off after `current_period_end + grace`.
4. **Cancel** — cancel in portal → `canceled`, plan retained, features off.
5. **House tenant** — an `internal` org: `orgCan` true for everything, untouched by webhooks.
6. **Idempotency** — re-send an event from the dashboard → no-op, state unchanged.

## Rollback
Revert the Railway deploy (or delete the two new services) and, if needed, run the
down migration. All changes are additive, so existing tenants are unaffected either
way.
