# Daily operator health email

The operator sells CrankLeads (auto-provisioned EmpireVu orgs) and should not have to watch
dashboards. Once a day the worker emails `OWNER_EMAIL` a short list of **only the accounts and
things that need a human**, most severe first, each with what is wrong, how long it has been
wrong, and the one thing to do (with app / Stripe links where an id exists). If nothing needs
attention, nothing is sent, except a short "all clear" on Mondays so you know it is running.

Subject examples:

- `CrankLeads health: 3 need you (1 guarantee at risk)`
- `CrankLeads health: 1 needs you`
- `CrankLeads health: all clear` (Mondays only, when nothing is flagged)

## When it runs

- Inside the existing **[worker]** (`npm run worker:workflow-events`) scheduler pass
  (`runScheduler` in `src/server/services/workflow-engine/scheduler.ts`). It is checked every 5
  minutes (same throttle as the setup follow-ups). No new Railway service.
- At or after **07:30 operator time** (`BUSINESS_TIMEZONE`, default `America/Toronto`), once per
  operator-local calendar day. If the worker was down at 07:30 the report goes out as soon as it
  is back, the same day.
- **Idempotent per day.** The run INSERTs the day's `operator_health_reports` row (unique
  `report_date`) **before** sending. A second worker, a restart or a re-run gets a unique
  violation and sends nothing. A send that fails is recorded as `failed` and is **not** retried
  automatically. A timeout is ambiguous, and a duplicate is worse than a gap. Use
  `npm run job:operator-health -- --send` to resend by hand.
- If Resend is not configured (`RESEND_API_KEY` / `OUTBOUND_FROM_EMAIL`), the day is NOT claimed
  (so it goes out once configured) and one error line is logged per day.

## What gets flagged

| Section | Rule | Severity | The one action |
|---|---|---|---|
| Provisioning failures | `crankleads_purchases.status = 'failed'` (updated in the last 30 days), or stuck in `paid` / `provisioning` for ≥ 60 min (the 15-min `--stuck` sweep did not fix it). `checkout_created` is an abandoned checkout and never flagged. | critical | `npm run job:crankleads-provision -- --session cs_…` (exact session id) |
| Call forwarding broken | Active Twilio catcher number (`voice_numbers` `mode='missed_call_catcher'`) whose `forwarding_last_test_result` is `not_forwarded` or `failed`, **and** it used to work (a `passed` row in `forwarding_tests`, or a real forwarded `missed_calls` row with `forwarded_from`), **or** the account is live (`crankleads_purchases.live_at`). A number that never worked is a setup problem and shows under Setup stalled instead. Cancelled subscriptions are skipped. | critical if live, else high | Call the owner: re-dial the carrier code (e.g. `**004*…#`), then "Test my forwarding". "Failing for" counts from the first failed test after the last pass. |
| Setup stalled | Provisioned CrankLeads purchase, `live_at` null, setup checklist not live, subscription not `canceled`, **≥ 3 business days** (Mon–Fri, counted in the company's timezone) since `provisioned_at`. Days 3–4 = early warning (medium); day 5 = **5-business-day live guarantee** "deadline is today" (high); later = "N business days past" (critical). Shows done/total and the next missing step from `loadSetupChecklist` (`services/crankleads/setup-checklist.ts`, reused, not reimplemented). Notes when the owner turned the reminders off. | medium / high / critical | Call the owner and walk them through the next step; the owner's deep link is included. |
| Job queues | Per durable queue (`workflow_event_jobs`, `billing_event_jobs`, `jobber_sync_jobs`, `inbound_webhook_jobs`, the same list as `/api/health`, see `services/queue-health.ts`): jobs dead-lettered (`failed`, Jobber `manual_review`) in the last 24h, or a ready `pending` job unclaimed ≥ 30 min. | critical if not draining, else high | Check that Railway service / the failed rows (SQL included). |
| Payment problems | `organizations.subscription_status = 'past_due'` (Stripe `unpaid` maps there, see `billing/events.ts`), not the internal house plan. Critical once `current_period_end + BILLING_PAST_DUE_GRACE_DAYS` has passed (paid features are off). | high / critical | Stripe customer + subscription links; ask the owner to update the card. |
| Open support requests | `support_requests.status = 'open'` and sent ≥ 24h ago (high after 72h). | medium / high | Reply to the requester, then the exact `update support_requests set status = 'closed' …` line. |
| Silent accounts | Live CrankLeads account (`live_at` ≥ 14 days ago), subscription `active`/`trialing`, and zero new `contacts`, `missed_calls` and `retell_calls` in the last 14 days. | low | Check their forwarding + website form, then check in (churn risk). |
| Health checks that could not run | Any section whose query failed is listed (high). A broken query is never mistaken for "all clear". | high | Look at the worker logs. |

Sections are ordered by their most severe item; items by severity, then oldest first. Each
section shows at most 8 items, then `+N more`. The subject count includes the hidden ones.

Thresholds live in one place, `src/server/services/operator-health/rules.ts`.

## Env

All on the **[worker]** service.

| Var | Notes |
|---|---|
| `OWNER_EMAIL` | Existing. Recipient. Unset → the feature is off. |
| `APP_BASE_URL` | Existing. Owner deep links + the `/internal/ops` footer link. |
| `BUSINESS_TIMEZONE` | Existing. Operator timezone for the 07:30 send and the report date (default `America/Toronto`). |
| `RESEND_API_KEY`, `OUTBOUND_FROM_EMAIL` | Existing. Sending. |
| `OPERATOR_HEALTH_ENABLED` | **New, optional.** Default on when `OWNER_EMAIL` is set. `false` / `0` / `off` / `no` turns it off. |
| `OPERATOR_HEALTH_ALL_CLEAR` | **New, optional.** `weekly` (default, Mondays) or `never`. |
| `STRIPE_SECRET_KEY` | Optional, existing. Only the `sk_test_` prefix is read, to point links at `dashboard.stripe.com/test`. |

## CLI

PowerShell (note the `--`):

```
npm run job:operator-health -- --dry-run          # print today's report (default; sends nothing)
npm run job:operator-health -- --dry-run --all    # without the "+N more" caps
npm run job:operator-health -- --send             # email it to OWNER_EMAIL right now
```

`--send` does not claim the day, so the scheduled 07:30 report still goes out. Needs
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_BASE_URL`; `--send` also needs
Resend + `OWNER_EMAIL`.

## Data

`operator_health_reports` (migration `20261004150000_operator_health.sql`, rollback in
`supabase/rollback/`): one row per operator-local day: `status` (`sending` → `sent` |
`failed`, or `quiet` when nothing was sent), `item_count`, `guarantee_at_risk`, `all_clear`,
`subject`, `summary` (per-section counts). It holds no tenant row content. It is a
**platform-level** table (no `organization_id`, tenancy exception like `crankleads_purchases`):
RLS on, no policies, no anon/authenticated grants.

Useful queries:

```sql
select report_date, status, item_count, guarantee_at_risk, subject, error
from operator_health_reports order by report_date desc limit 14;

-- Resend today's report from the worker (instead, prefer: npm run job:operator-health -- --send)
delete from operator_health_reports where report_date = current_date;
```

## Security (sanctioned service-role exception)

The loader reads across tenants with the service role. This is a **sanctioned exception**
(header comments in `services/operator-health/load.ts`, `service.ts` and
`jobs/operator-health.ts`; listed in `EMPIREVU_RUNBOOK.md`). It is operator-only and aggregate,
and it takes **no request input**: it runs in the worker or the CLI, with no route. Per-account
reads (setup checklist, activity counts, forwarded-call proof) are filtered by each row's own
stored `organization_id` (+ `company_id`). The only write is the `operator_health_reports` row.
The only recipient is `OWNER_EMAIL`. Tenant-supplied text (business names, support questions) is
HTML-escaped in the email.

## Code map

- `src/server/services/operator-health/rules.ts`: PURE facts → report (every rule + thresholds,
  ordering, caps, all-clear decision).
- `src/server/services/operator-health/render.ts`: PURE report → subject / text / html.
- `src/server/services/operator-health/load.ts`: the cross-tenant reads (facts).
- `src/server/services/operator-health/service.ts`: config, the daily claim-and-send, the CLI
  runner.
- `src/server/services/queue-health.ts`: the queue table list shared with `/api/health`.
- `src/server/jobs/operator-health.ts`: the CLI.
- Tests: `src/test/operator-health.test.ts` (+ golden snapshots in `src/test/__snapshots__/`).
