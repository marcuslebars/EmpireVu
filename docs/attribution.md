# Revenue attribution — "Captured by EmpireVu"

Task 14 answers one question for the owner: **how much revenue did EmpireVu capture this
month, and where did it come from?** It is a read-only report — a dashboard card with the
headline number and a `/reports/attribution` screen with the per-quote drill-down and a
client-side CSV export. No new writes, no new Stripe handling, no new export endpoint.

## Where the numbers come from

- **View** `public.revenue_attribution_v` — one row per quote that is **approved or paid**
  (`approved_at is not null OR deposit_paid_at is not null`). `security_invoker`, so the
  caller's RLS on `quotes` (and the joined tables) decides what they can see; the server
  query also adds `.eq("organization_id", …)`.
- **RPC** `public.ui_attribution_summary(p_org_id, p_company_id, p_from, p_to)` — one
  aggregate row over the view for the period, plus the automation time-saved total.
- **Service** [`src/server/services/attribution.ts`](../src/server/services/attribution.ts) —
  `getAttributionSummary`, `listAttribution`, and the pure `deriveFirstTouch` /
  `monthRangeInTimeZone` helpers (golden-tested in
  [`src/test/attribution.test.ts`](../src/test/attribution.test.ts)).

Migration: `supabase/migrations/20260912120000_revenue_attribution.sql`
(rollback: `supabase/rollback/20260912120000_revenue_attribution.down.sql`).

## Period boundaries (Amendment 4)

The default window is **the current calendar month in the company's timezone**:
`companies.timezone` → `BUSINESS_TIMEZONE` → `America/Toronto` (the same fallback chain as
the Task 9 scheduler). `monthRangeInTimeZone` computes the `[from, to)` UTC instants
DST-safely — each boundary's offset is taken at its own local midnight, so a month that
straddles a spring-forward / fall-back still starts and ends at local 00:00. A quote is
counted in the period whose bounds contain `coalesce(approved_at, paid_at)`.

## `revenue_attribution_v` columns

| Column | Meaning |
| --- | --- |
| `organization_id` | Owning org (RLS + explicit server filter). |
| `company_id` | The quote's company (the drill-down / card filter). |
| `quote_id` | `quotes.id`. One row per approved-or-paid quote. |
| `contact_id` | The quote's contact (nullable). |
| `auto_generated` | `quotes.auto_generated` — was the quote drafted by automation. |
| `first_touch_source` | Source of the earliest touch (see below). `'manual'` when none. |
| `first_touch_channel` | `web` \| `voice` \| `sms` \| `email` \| `manual`. |
| `first_touch_at` | Timestamp of that earliest touch (falls back to the contact's `created_at`). |
| `voice_ai_involved` | A `retell_calls` row exists for the contact at/before close. |
| `automation_involved` | A **completed** `workflow_runs` row whose trigger targeted the contact exists at/before close. |
| `approved_cents` | `quotes.approved_total_cents` — the value of the won quote. |
| `paid_cents` | Deposit actually collected (see below); `0` until paid. |
| `approved_at` | `quotes.approved_at`. |
| `paid_at` | `quotes.deposit_paid_at`. |

"Close" = `coalesce(approved_at, deposit_paid_at)` — the involvement checks use touches at or
before this instant so a signal only counts if it happened before the quote closed.

### `first_touch` rule (Amendment 3 — deterministic)

The earliest touch on the quote's contact, across three sources, each carrying a rank used
only to break exact-timestamp ties:

1. **rank 0 — `raw_leads`** → channel `web`, source `coalesce(source, source_site, 'web')`,
   at `created_at`.
2. **rank 1 — inbound `retell_calls`** → channel `voice`, source `retell`,
   at `coalesce(received_at, created_at)`.
3. **rank 2 — inbound `message_log`** → channel `email` when the message channel is `email`
   else `sms`, source = the message channel, at `created_at`.

Ordered `by ts asc, rnk asc, limit 1`. **On an exact-timestamp tie, `raw_leads` wins**
(0 < 1 < 2). If the contact has no touch (or the quote has no contact), first-touch is the
contact's own `created_at` with source/channel `manual`.

### `paid_cents` — what "collected" counts (Amendment 2, traced not invented)

The **only** event that marks a quote paid is Stripe **`checkout.session.completed` on the
company's connected account**, handled by `markQuoteDepositPaid` in
[`src/server/services/quotes/checkout.ts`](../src/server/services/quotes/checkout.ts), which
is the sole writer of `quotes.deposit_paid_at`. That webhook path
(`/api/webhooks/stripe/connect`) charges and records the **deposit**, so:

```
paid_cents = (deposit_paid_at is not null)
             ? coalesce(approved_deposit_cents, deposit_cents)
             : 0
```

No other Stripe event (balance invoices, refunds, payment-intent events) is counted, and
this task adds **no new Stripe handling**. If balance collection is later routed through our
webhook, extend `paid_cents` here and update this note.

## `ui_attribution_summary` (aggregate)

Filters the view to the org (+ optional company) and the period cohort
(`coalesce(approved_at, paid_at) ∈ [p_from, p_to)`), returning one row:

| Field | Meaning |
| --- | --- |
| `quotes_count` | Quotes approved or paid in the period. |
| `approved_cents_total` / `paid_cents_total` | Sum of `approved_cents` / `paid_cents`. |
| `voice_ai_count` / `voice_ai_approved_cents` / `voice_ai_paid_cents` | Same, restricted to `voice_ai_involved`. |
| `automation_count` / `automation_approved_cents` / `automation_paid_cents` | Same, restricted to `automation_involved`. |
| `estimated_time_saved_seconds` | Sum of `workflow_runs.time_saved_seconds` for **completed** runs in the period (org/company scoped). |
| `by_source` / `by_channel` | jsonb `{ key: { count, approved_cents, paid_cents } }` breakdowns by first-touch source / channel. |

## UI

- **Dashboard card** — "Captured by EmpireVu": collected-this-month headline (paid), with
  approved / quote / voice-AI / automation context. Links to the report.
- **`/reports/attribution`** — summary tiles, a Recharts bar of collected-by-source, the
  per-quote table, and **Export CSV** built from the already-fetched rows (no export API).

Naming is persona-agnostic on purpose (Amendment 1): the columns are `voice_ai_involved` /
`automation_involved`, never a front-desk employee's name — owners rename that employee, the
schema never changes.
