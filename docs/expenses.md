# Expenses & receipts

Log what the business spends, with the receipt attached, on a job or as overhead. Job
expenses count in job profit, billable ones go on the job's invoice, out-of-pocket ones are
tracked until paid back, and Reports shows spending by category.

Migration `20261005180000_expenses.sql` (rollback in `supabase/rollback/`).

## Data

`expenses` — one row per expense:

| Column | Meaning |
| --- | --- |
| `spent_on` | Date on the receipt. |
| `amount_cents` / `tax_cents` | Total paid **with tax included**, and the sales tax inside it. Costs everywhere use `amount − tax` (before tax), matching revenue, which is also counted before tax. |
| `category` | One of a fixed list (materials, fuel, equipment, tools, subcontractor, vehicle, insurance, office, marketing, meals, travel, utilities, fees, other). |
| `booking_id` | The job, or null for overhead. `company_id` follows the job; otherwise the one chosen, or the org's only company. |
| `paid_with` | `business` or `personal`. Personal = owed back until `reimbursed_at`. |
| `billable` / `billed_invoice_id` | Bill to the customer on the job's invoice. A voided invoice releases the expense. |
| `receipt_path` / `receipt_type` | `{org}/{uuid}.jpg|pdf` in the private `expense-receipts` bucket. Unique. |

RLS: crew see/insert/edit/delete **their own** rows until reimbursed or billed; owners/admins
everything. Nobody can insert as someone else or mark their own row reimbursed/billed.

## Receipts

`expense-receipts` has **no storage policies**. `services/expenses/receipts.ts` (sanctioned
service-role exception) mints a one-time signed upload URL under the caller's org prefix,
signs short-lived read URLs only for paths read off rows the caller can already see, checks
an upload exists before an expense points at it, and deletes replaced / deleted files. The
app re-encodes photos to JPEG (max 2048px, EXIF/GPS stripped); PDFs go up as-is (10 MB max).

**Reading receipts with AI**: `POST …/expenses/receipt-scan {path}` downloads the file and
asks Claude (`src/server/ai/receipt-reader.ts`, model `AI_MODEL_RECEIPTS`, falls back to the
default) for vendor / date / total / tax / category / description as strict JSON.
`cleanReceiptScan` drops anything doubtful (dates outside a year back / a week ahead, tax over
the total, unknown categories). Nothing is saved — the form fills its blanks for the person to
check. 60 scans per user per hour; AI usage is metered. Without `ANTHROPIC_API_KEY` the route
returns 503 `ai_unavailable` and the form just stays manual.

## Where expenses show up

- **Job sheet → Expenses**: "Add receipt" (pinned to the job), the job's receipts.
- **Job profit** (`time/service.ts`): `expensesCents` (before tax) is a cost next to labour
  and materials; the job-profit report's "Materials & expenses" column includes it.
- **Invoices**: `createInvoiceFromBooking` / `createInvoiceFromQuote` (with a booking) add
  each billable, unbilled expense as a line at cost before tax — label "What (Where)" — then
  mark them billed. This goes through security-definer `billable_expenses_for_booking` /
  `mark_expenses_billed`, because the person invoicing (maybe crew finishing the job) can't see
  other people's expenses. Never fails the invoice. Auto-invoice still treats a $0 job line as
  "needs a price", so billed expenses alone never cause an unpriced job to be sent.
- **Reports → Spending / Where the money went**: spent this period vs last (before tax), on
  jobs vs overhead, by category, and what's owed back today. CSV gains a "Spent" column.
- **Expenses page** (`/expenses`): range / category / job-or-overhead / person / search
  filters, totals (spent, before tax, sales tax paid, owed back), "Owed back to your team" with
  Mark paid back (owners/admins), CSV export for the bookkeeper.

## API

All under `/api/organizations/{orgId}/expenses`:

| Route | |
| --- | --- |
| `GET ?from&to[&category&bookingId&profileId&companyId&kind&owed&q]` | List + summary. Range ≤ 2 years unless `bookingId`. |
| `POST` | Create. |
| `GET/PATCH/DELETE /{id}` | One expense. `receipt: null` removes the receipt, omitted keeps it. |
| `POST /receipt-upload {type}` | Signed upload URL. |
| `POST /receipt-scan {path}` | AI suggestions. |
| `POST /reimburse {ids, reimbursed}` | Owners/admins. |
| `GET /export?…` | CSV, oldest first, same filters. |

## Env

`AI_MODEL_RECEIPTS` (optional, `[web]`) — model for reading receipts; set `AI_PRICE_*` to match
if you move it to a cheaper model. Needs the existing `ANTHROPIC_API_KEY`.
