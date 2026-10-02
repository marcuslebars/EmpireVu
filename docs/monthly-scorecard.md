# Monthly results scorecard

The CrankLeads promise: **"Monthly results scorecard: leads caught, replies sent, jobs booked,
and what we're tuning next."** On the 1st of every month each client company's owner gets an
email with last month's numbers compared with the month before, up to three rule-based
"what we're tuning next" items, and an optional note from the operator. The same scorecard is
in the app at **Reports → Monthly results** (`/reports/monthly`), for this month so far and
last month.

This is **per company** (one email per company, like the daily digest) and is separate from the
per-AI-employee "monthly scoreboard / statement" planned in `NEXT_LEVEL_PLAN.md` Task 20. That
task hasn't been built (no `ui_employee_scoreboard`, no AI-employee tables). When it lands, its
statement can reuse this service's metric definitions and month helpers.

## Pieces

| Piece | File |
| --- | --- |
| Month boundaries (company TZ, DST-safe) | `src/server/services/monthly-scorecard/months.ts` (reuses `monthRangeInTimeZone` from attribution) |
| Metrics: tenant-scoped reads + pure computation | `src/server/services/monthly-scorecard/metrics.ts` |
| "What we're tuning next" rules | `src/server/services/monthly-scorecard/suggestions.ts` |
| Scorecard assembly, deltas, settings, operator note | `src/server/services/monthly-scorecard/scorecard.ts` |
| Send pass (idempotent, opt-out, dry-run) | `src/server/services/monthly-scorecard/send.ts` |
| Email template (HTML + text, pure) | `src/server/templates/monthly-scorecard.ts` |
| Platform brand (the ONE place) | `src/server/services/monthly-scorecard/platform-brand.ts` (`PLATFORM_BRAND_NAME`, default `CrankLeads`) |
| Cron job | `src/server/jobs/monthly-scorecard.ts`, `npm run job:monthly-scorecard`, `railway.monthly-scorecard.json` |
| API | `GET/PUT /api/organizations/:orgId/ui/monthly-scorecard` |
| In-app page | `src/screens/ReportsMonthlyPage.tsx` (`/reports/monthly`, linked from the attribution report and the command palette) |

Migration: `supabase/migrations/20261002150000_monthly_scorecard.sql` (rollback in
`supabase/rollback/`). It adds `companies.monthly_scorecard` (settings),
`monthly_scorecard_sends` (send log) and `monthly_scorecard_notes` (operator note). Both
tables have `organization_id` and the composite company FK, with RLS enabled.

## Month and timezone

A month is `YYYY-MM` in the **company's** timezone (`companies.timezone`, then
`BUSINESS_TIMEZONE`, then `America/Toronto`). It runs from `[local midnight on the 1st,
local midnight on the 1st of the next month)`. Each boundary uses its own UTC offset, so a
month that crosses a DST change still starts and ends at local midnight. For example,
March 2026 in Toronto is `05:00Z → 04:00Z` and November 2026 is `04:00Z → 05:00Z`.
The scheduled run reports on the **last complete month** in each company's timezone.

## Metric definitions

All counts are for one company and the `[from, to)` window. Every query filters by
`organization_id` **and** `company_id`.

| Metric | Definition |
| --- | --- |
| **Leads caught** | `contacts` created in the month. |
| Lead source | Checked in this order: **Missed-call catcher** (a `call.missed` event for the contact from 10 min before to 30 min after it was created), then **Referral** ("referral"/"referred" in `metadata.source`, `sourceSite`, UTM source/medium or `raw_leads.source`), then **Phone (AI receptionist)** (`formType = phone-lead` or a retell/telnyx/voice/phone source), then **Web form** (intake `formType` quote/contact/booking/winter-storage-quote, a linked `raw_leads` row, or a public-booking `booking.created` event), then **Text message** (`consent_source = inbound_sms`), and finally **Other / manual**. |
| **Missed calls caught** | `activity_events` of type `call.missed` in the month. Retell classifies a call as missed when it hits voicemail, lasts under 5 s, or is unsuccessful. |
| Texted back | Missed calls with a known contact that got a **sent** outbound SMS within 60 minutes. |
| **Replies sent** | `message_log` rows that are outbound, have status `sent` and have a **contact** (so owner alerts and this email are excluded). "Automatic" means it has a `workflow_run_id`. |
| Automations run | `workflow_runs` created in the month with status `completed`. |
| Median first response | For each new lead: the time from `created_at` to the first sent outbound message or outbound call to that contact, looked for up to 7 days after the month ends. The median is taken over leads that got a response. It is `—` when no lead got one. |
| Quotes sent / approved / deposits | `sent_at` / `approved_at` / `deposit_paid_at` in the month. Approved amount is `approved_total_cents`, else `total_cents`. Deposit amount is `approved_deposit_cents`, else `deposit_cents`. These are Stripe-backed quote data, and no amounts are hardcoded. |
| **Jobs booked** | `bookings` created in the month that aren't `cancelled`. *Jobs completed* (used only by the review rule) is bookings scheduled in the month with status `completed`. |
| Reviews requested | Completed runs (`completed_at` in the month) of the company's `review-request` workflow. |
| AI receptionist | Calls handled are inbound `retell_calls` created in the month. Minutes are the metered `usage_events.voice_minutes` for the company. The line only shows when there were calls in this month or last month. |
| Revenue we helped win | `getAttributionSummary` (see [attribution.md](attribution.md)) over the month: `paid` (collected) and `approved`. |

**Deltas** compare each number with the previous calendar month. The percent is `null` when
last month's value was 0, so there is no divide-by-zero. **First month:** when the company
was created during the month, or last month had no activity at all, there are no deltas and
the email says *"This is your first month on the scorecard…"*. An empty month gets the
subject *"Your October results: a quiet month"*, and every ratio rule is skipped when its
denominator is 0.

## What we're tuning next

These are deterministic rules, checked in priority order. The first three that fire are shown
(`MAX_SUGGESTIONS = 3`). When the recipe a rule would turn on is already `active`, the rule
says what we'll tune instead.

1. **Missed-call text-back**: fires when fewer than 80% of missed calls were texted back. It suggests turning on `missed-call-text-back`, or closing the gaps if that recipe is already on.
2. **First response**: fires when the median first response is over 15 minutes. It suggests turning on `new-lead-owner-alert`, or adding an instant auto-reply if that recipe is already on.
3. **Quote follow-up**: fires when 3 or more quotes were sent and fewer than 40% of them were approved. It suggests turning on `quote-follow-up`, or tuning it if it's already on.
4. **Review requests**: fires when jobs were completed and fewer than half as many review requests went out. It suggests turning on `review-request`, or asking for more reviews if it's already on.
5. **No leads**: fires when the month had no new leads. It suggests checking the lead sources.
6. **Deposits**: fires when 2 or more quotes were approved but deposits were paid on fewer than half of them. It suggests collecting more deposits up front.

When no rule fires, the email says "Everything's running well…".

**Operator note** is optional free text, up to 2000 chars, one per (company, month). An org
**owner/admin** sets it with `PUT /ui/monthly-scorecard` `{ companyId, month, operatorNote }`
or from the Monthly results page. An empty value clears it. RLS also limits writes to
admins (`monthly_scorecard_notes_admins_*` policies). It shows under "A note from your
account team". The label doesn't use the platform brand, because any org admin can write the
note, not just CrankLeads staff. To get a note into the email, set it for the month being reported (for
example the October note before the November 1st run).

## Sending, idempotency, opt-out

- **Recipient**: `resolveOwnerContacts(…, { allowPlatformFallback: false })`:
  `companies.owner_email`, then the org's **owner**, then an **admin**, using their profile
  email. It **never** uses the global `OWNER_EMAIL`, not even for the house org. That inbox
  belongs to the platform, so falling back to it would email one tenant's results to the
  platform, and the client would never get them. With no recipient, the company is skipped
  and logged as `skipped / no_email`.
- **Delivery**: `deliverMessage` (email). It writes `message_log` with no contact and meters
  `email_sent`. The From display name is `PLATFORM_BRAND_NAME`. Owner reporting has no consent
  check and no approval gate, the same as the digest.
- **Opt-out**: `companies.monthly_scorecard = { "enabled": false }`. By default it's enabled,
  because every done-for-you client gets one. Admins can toggle it on the page or with
  `PUT { companyId, enabled }`. Opted-out companies are logged as `skipped / opted_out`.
  The scorecard is a company-level report like the digest's `companies.digest`, so per-user
  push `notification_preferences` don't apply to it.
- **Also skipped**: companies with `stage` set to `paused`/`archived`, orgs whose
  `subscription_status` is `canceled`, companies created after the month ended, and a month
  that isn't over yet.
- **Idempotency**: `monthly_scorecard_sends` has `unique(company_id, month)`. The job inserts
  (claims) the row **before** sending. A second run, or one running at the same time, sees
  `sent`/`claimed` and sends nothing. A `failed` or `skipped` row is re-claimed by the next
  run with a conditional update, so only one claimer wins. `--force` re-sends a `sent` month
  (`send_count` increments), and the job only accepts it together with `--company`. A row
  stuck at `claimed` after a crash also needs `--force`.

## Running it (PowerShell)

```powershell
# Preview everything (writes nothing, sends nothing):
npm run job:monthly-scorecard -- --dry-run
# Preview one company for a given month (prints the plain-text email):
npm run job:monthly-scorecard -- --dry-run --company <companyId> --month 2026-09
# Send one company's month (no-op if already sent):
npm run job:monthly-scorecard -- --company <companyId> --month 2026-09
# Re-send (operator correction):
npm run job:monthly-scorecard -- --company <companyId> --month 2026-09 --force
```

The job exits with a non-zero code when any send failed. Railway runs it on the 1st at 13:00
UTC (`0 13 1 * *`, which is 08:00/09:00 in Toronto). The job uses the service role (sanctioned
exception: jobs) and filters every read and write by the company's own
`organization_id` + `company_id`.

## Tests

`src/test/monthly-scorecard.test.ts` covers month boundaries including both DST changes,
lead-source rules, golden October metrics, an empty month, deltas, suggestion rules, and
golden email rendering. `src/test/monthly-scorecard-send.test.ts` covers the send pass:
idempotency, claim contention, failed retry and `--force`, opt-out and other skips, dry run,
tenancy filters on every query, CLI args, the operator note, and route admin-gating. The
fixtures in `src/test/monthly-scorecard-fixtures.ts` give the expected value next to each row.
