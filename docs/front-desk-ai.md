# AI front desk (Phase 1)

## Weekly report

Every Monday at 08:00 company time, the owner gets a short "what your front desk did" report for the Monday–Sunday week that just ended: a 3-line text and a full email, plus the same numbers in the app. It's the proof of value. It shows what the front desk handled, so cancelling means hiring someone to do it.

### What's in it

Code: `src/server/services/weekly-report/metrics.ts` (`computeWeeklyMetrics` is pure and fixture-tested; `fetchWeeklyInputs` is the tenant-scoped reads).

| Number | Definition |
| --- | --- |
| Calls answered by your AI | Inbound `retell_calls` created in the week, excluding voicemail and calls under 5 s. |
| After hours | Of those, how many started outside `companies.hours`. The hours are read with `dfy/hours.ts`, which takes the earliest open to the latest close on open days. If the hours can't be read, this shows `null` and we claim none. |
| Customer text conversations | `sms_conversations` whose `last_ai_reply_at` falls in the week. This undercounts a conversation the AI replied to again after the week ended. |
| Things it checked with you first | `owner_approvals` created in the week. "Approved" counts rows decided in the week with status `approved` or `executed`. |
| Missed calls caught / texted back, new leads, quotes sent/approved ($), jobs booked, reviews requested | The monthly scorecard's definitions (`fetchScorecardInputs` / `computeScorecardMetrics`) applied to the week. |
| Deposits & payments collected | Quote deposits paid in the week, plus `invoice_payments` with status `succeeded` received in the week. |
| Time saved (estimate) | See below. Always labelled as an estimate. |

All front-desk reads are tolerant: an empty or not-yet-migrated table counts as zero and never fails the report. New Google reviews are left out. `companies.google_review_count` is written once at enrichment and never refreshed, so a weekly change can't be worked out from it.

### Hours saved: an estimate

All the assumptions live in one constant, `HOURS_SAVED_ASSUMPTIONS` in `weekly-report/metrics.ts`:

- 3 min per AI-handled text conversation
- 4 min per call answered
- 5 min per quote sent
- 2 min per job booked
- 1 min per missed call texted back

The time is valued at **$22/hour**, an Ontario receptionist wage, for the "about $X of receptionist time" line. The email footer and the in-app page print the assumptions (`hoursSavedAssumptionsText()`).

### Weeks and timezones

The week helpers are in `src/server/services/monthly-scorecard/weeks.ts`, next to `months.ts`:

- A week is keyed by its Monday (`YYYY-MM-DD`).
- `weekRangeForKey` runs from local midnight Monday to local midnight the next Monday. It is DST-safe: a spring-forward week is 167 h and a fall-back week is 169 h (tested for America/Toronto).

### Sending

Code: `src/server/services/weekly-report/send.ts`.

- **When.** The scheduler calls `processWeeklyReports(admin, nowMs)` every tick (one line in `runScheduler`).
  - It does no DB reads unless it could be Monday or Tuesday morning somewhere, i.e. between Sunday 18:00 and Wednesday 09:00 UTC.
  - It runs at most every 10 minutes per process.
  - A company is sent to only inside its local window: Monday 08:00–21:00, or Tuesday 08:00–21:00 as a catch-up day if the worker was down.
- **Idempotent.** The pass inserts the `weekly_report_sends` row (unique per company and `week_start`) *before* sending, so a concurrent worker gets a 23505 and sends nothing.
  - A `failed` row is re-claimed by a conditional update, which only one worker can win, at most hourly.
  - A row stuck in `claimed` is left alone rather than risking a double send.
  - If one channel sends and the other fails, the row is `sent`, with the error in `last_error`.
  - The row's `metrics` stores what was sent. The in-app page shows those numbers for sent weeks.
- **Channels.**
  - **SMS** goes to CrankLeads orgs only. It is sent from the **platform number** (`smsFrom: "platform"`) to `companies.owner_phone_e164`. It is GSM-7, at most 2 segments, and has 3 lines: who/when, what happened, and hours saved plus a link to `/reports/weekly?week=…`.
  - **Email** goes to the monthly scorecard's owner resolution: `owner_email`, then the org owner/admin, and never the platform `OWNER_EMAIL`. The template is `src/server/templates/weekly-report.ts`, in the scorecard's house style.
  - The brand is the org's platform brand (`scorecardPlatformBrandName`), so a CrankLeads org's report never says EmpireVu.
- **Who doesn't get one** (skip reasons):
  - `disabled`: the setting is off.
  - `inactive_company`: the company is paused or archived.
  - `org_canceled`
  - `not_live`: the account wasn't live by the end of the week, i.e. `crankleads_purchases.live_at`, stamped from the setup checklist's `isLive`, is unset or later. This also covers a company created after the week.
  - `week_not_over`
  - `outside_send_window`
  - `no_recipient`
  - `no_activity`: an all-zero week **and** no activity (messages, calls or new contacts) in the last 30 days. This is recorded so later passes don't recompute it.
  - A quiet week *after* recent activity still gets a short "quiet week" note.

### Settings

The settings live in `companies.ai_settings.weekly_report = { enabled?, channels? }`. The only reader is `weekly-report/settings.ts`. Defaults:

- **On** for CrankLeads orgs, sent by text and email.
- **Off** for everyone else, email only. For non-CrankLeads orgs, `sms` is always filtered out.

The routes are owner/admin only, and the company must be in the org:

- `GET` / `PATCH /api/organizations/:orgId/companies/:companyId/ai-settings/weekly-report`. `PATCH` merges **only** the `weekly_report` key. The write is optimistic on `companies.updated_at`, so a concurrent write to another section isn't clobbered.
- `POST …/ai-settings/weekly-report/test` ("Send a test to me"). It emails last week's report to the person clicking and, when the text channel is on, texts the owner's cell. The subject is prefixed `[Test]`. It does not claim the week.

The UI is `src/components/settings/WeeklyReportSettingsSection.tsx`. Its props are optional and default to the selected org and company. The lead wires it into the AI front desk panel.

### In the app

- **Dashboard card:** `src/components/reports/WeeklyFrontDeskCard.tsx`. It shows this week so far: the hours-saved estimate, calls, texts, jobs and collected, plus a line for last week and a link to the full report.
- **Page:** `/reports/weekly` (`src/screens/ReportsWeeklyPage.tsx`). It shows the selected week's detail and a table of the last 8 weeks.
- **API:** `GET /api/organizations/:orgId/ui/weekly-report?companyId=&weeks=8&includeCurrent=1` (any member, RLS client). Client hooks are in `src/lib/weekly-report-api.ts`.

### CLI

```
npm run job:weekly-report -- --dry-run
npm run job:weekly-report -- --dry-run --company <companyId> --week 2026-10-05
npm run job:weekly-report -- --company <companyId> --week 2026-10-05
npm run job:weekly-report -- --company <companyId> --week 2026-10-05 --force   # re-send
```

- `--week` takes any date and normalizes it to that week's Monday. With no `--week`, the job reports on the last complete week in each company's timezone.
- A manual run ignores the Monday-morning window but keeps every other rule.
- A single-company dry run prints the text message and the plain-text email.
- `--force` requires `--company`.

Tests: `src/test/weekly-report.test.ts`.
