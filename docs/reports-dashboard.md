# Reports dashboard

`/reports` (sidebar → Reports) is one page that answers "how is the business doing?"
for a date range. Owners and admins only; crew see a short "Reports are for owners and
admins" note. The older pages are still linked from its header: Monthly results
(`/reports/monthly`) and Captured by EmpireVu (`/reports/attribution`).

## Ranges

Presets: this month (default), last month, last 30 days, this quarter, last quarter, year
to date, last 12 months, and a custom from/to. The range lives in the URL
(`?range=custom&from=…&to=…`), so a view can be bookmarked or shared with another owner.
Dates are calendar days in the company's time zone (`companies.timezone` →
`BUSINESS_TIMEZONE` → America/Toronto). Ranges are capped at two years.

Every figure is compared with a previous period, named under the page title:
- a range starting **Jan 1** (longer than two months) → the same dates a year earlier;
- a range starting on the **1st of a month** → the same span of months just before it
  (this month to date → the same days of last month; a quarter → the quarter before);
- anything else → the same number of days just before.

Charts bucket by day (≤ 45 days), week (≤ 200 days, weeks start Monday) or month.

## What each number means

| Figure | Definition |
|---|---|
| Collected | Invoice payments with status `succeeded` received in the range, plus quote deposits paid in the range. Pending (e.g. a PAD still clearing), failed and refunded payments are not counted. An invoice made from a quote credits the deposit, so deposits are never counted twice. |
| Invoiced | Invoices **issued** in the range (issue date), excluding drafts and void invoices. |
| Owed to you today | Open invoices (sent, viewed, partially paid) with a balance — **as of today**, not the range. Aging is by days past the due date. "Already sent and clearing" is money a customer has paid that hasn't settled yet. |
| Jobs done | Bookings scheduled in the range with status completed. "Still to do" = not yet done and scheduled from now on; no-shows and cancellations are counted separately. |
| Quote win rate | Of the quotes **sent** in the range (revisions that were replaced by a newer quote are skipped), how many have been approved so far. A quote sent last month and approved this month is last month's win. |
| Quote value approved | Quotes approved in the range (approved total, else the quote total). |
| New customers | Contacts created in the range. |
| Crew hours | Time entries that started in the range, less breaks. With a company selected: that company's time plus general time (no company). Labour cost uses each person's pay rate; anyone without one is named rather than costed at $0. |
| Top customers | The five customers who paid the most in the range (invoice payments + deposits). |

The definitions are pinned by `src/test/reports-overview.test.ts`.

## Code

- `src/server/services/reports/overview-logic.ts` — pure: ranges, buckets, all the maths.
- `src/server/services/reports/overview.ts` — reads under the caller's session (RLS), in
  pages of 1,000 rows, filtered by organization (and company when one is selected).
- `GET /api/organizations/{orgId}/reports/overview?from=YYYY-MM-DD&to=YYYY-MM-DD[&companyId=]`
  (`to` exclusive) — owners/admins, 403 for crew, 400 for a bad range.
- `src/screens/ReportsPage.tsx`, `src/lib/reports-api.ts` — the page, presets and CSV export.

No migration: it reads existing tables only.
