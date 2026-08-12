# Stripe-native quotes

EmpireVu is replacing Jobber's client-hub checkout for NEW quotes with a Stripe-native flow:
price a quote → customer approves online → pays a 25% deposit → balance invoice on
completion. This makes the A1 stack independent of Jobber (which stays live for in-flight
jobs and winds down naturally).

Rolled out in four phases. **The whole feature is inert unless `STRIPE_QUOTES_ENABLED=1`.**

- **Phase 2 (this doc — shipped):** the quotes domain model + pricing. No Stripe API yet.
- **Phase 3:** hosted approval page `/q/{public_token}` + Stripe deposit Checkout (Stripe Tax) + expiry cron.
- **Phase 4:** balance invoice + jobs stub + refund path + reporting.

## Phase 2 — domain model + pricing

### Pricing (the money contract)

`src/server/services/quotes/pricing.ts` → `priceQuote(input)`. The subtotal + line items come
**straight from the shared `@a1/pricing-engine`** (`calculateQuote`, storage line), so a quote
can never diverge from a phone/calculator quote. On top of the engine subtotal it adds only
what the engine deliberately leaves out:

- **HST** (`taxRateBps`, default 1300 = 13%) — a quote-time estimate; **Stripe Tax is authoritative at charge time** (Phase 3).
- **tax-inclusive total** = subtotal + tax.
- **deposit** = `round-half-up(depositRate × total)` (default 2500 bps = 25%), clamped to never exceed the total.

All integer cents, pure + deterministic — locked by golden tests in
`src/test/quote-pricing.test.ts`, with anchor values captured from the real engine via
`scripts/dev/price-explore.ts`:

| Config | Subtotal | +HST 13% | Total | Deposit 25% |
| --- | --- | --- | --- | --- |
| 24ft à la carte (outdoor + shrink + winterization outboard) | $1,761.00 | $228.93 | $1,989.93 | $497.48 |
| 24ft Winter Ready Plus bundle (10% off) | $1,584.90 | $206.04 | $1,790.94 | $447.74 |
| 40ft Full Care bundle (inboard twin) | $3,939.10 | $512.08 | $4,451.18 | $1,112.80 |

> **On the planning anchors.** The earlier plan cited "24ft = $2,075" and "Nestor = $5,065".
> Those don't map to any clean catalog config — a standard 24ft winter bundle is $1,761 à la
> carte ($1,584.90 bundled), and even a 45ft full-care job is $4,326. They were specific
> historical quotes; "Nestor" is a named job whose exact line items aren't in the repo. To
> reproduce either exactly, provide its line items and it becomes a golden fixture.

### Data model

`supabase/migrations/20260812000000_add_stripe_quotes.sql`:

- **`quotes`** — the priced snapshot (line_items, subtotal/tax/total/deposit cents, rate bps),
  lifecycle `status` (draft → sent → approved → deposit_paid, or expired / cancelled),
  `public_token` for the Phase 3 page, `input_snapshot` for reprice/audit, nullable `stripe_*`
  columns (filled in Phases 3-4), and `expires_at`.
- **`quote_events`** — append-only audit (created | priced | sent | viewed | approved |
  deposit_paid | expired | cancelled | repriced).
- RLS: org members read + write (Hub-created, unlike the webhook-driven telnyx_/retell_
  tables); the Phase 3 Stripe webhook writes via the service role (RLS-exempt).

Apply it in the Supabase SQL editor (Railway doesn't run migrations). `quotes`/`quote_events`
aren't in the generated `database.types.ts` yet, so the service accesses them via an
`as any` cast — regenerating types restores first-class typing.

### API

`POST /api/organizations/{organizationId}/quotes` — authenticated, org-scoped. Body:
`contactId?`, `companyId?`, `services[]` (each `serviceId` + optional `lengthFt` / `engineType`
/ `engineCount`), `hullType?`, `bundleId?`, `notes?`, `source?`. Prices the bundle, persists
the quote, logs a `created` event, returns the quote (201). `GET` lists the org's quotes.
Both return **404 while `STRIPE_QUOTES_ENABLED` is off**.

Storage service ids: `outdoor_storage`, `shrink_wrap`, `winterization_{outboard|sterndrive|inboard}`,
`fall_detail`, `spring_commissioning`, `ceramic_upgrade`. Bundles: `winter_ready`,
`winter_ready_plus`, `full_care`. Hull types: `pontoon`, `tritoon`.

### Config

| Variable | Default | Notes |
| --- | --- | --- |
| `STRIPE_QUOTES_ENABLED` | `0` (off) | Master flag for the whole feature. |
| `QUOTE_TAX_RATE_BPS` | `1300` | HST estimate; Stripe Tax authoritative in Phase 3. |
| `QUOTE_DEPOSIT_BPS` | `2500` | Deposit as a fraction of the tax-inclusive total. |
| `QUOTE_EXPIRY_DAYS` | `30` | Quote validity window → `expires_at`. |

### Deferred to Phases 3-4

Stripe Checkout for the deposit (`setup_future_usage: 'off_session'`), Stripe Tax, the hosted
`/q/{token}` approval page, the expiry cron, the balance invoice, refunds, and reporting.
Storage-line services only for now; marine-care line items (ceramic / detailing) are a later
extension. **Read boatnames.ca's Stripe Checkout + Stripe Tax implementation first** when
starting Phase 3 — it's the in-house CAD/HST reference.
```

