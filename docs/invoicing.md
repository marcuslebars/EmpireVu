# Invoicing

Brands invoice customers and business accounts (marinas) from EmpireVu, convert
quotes and bookings into invoices, and get paid by card, Apple Pay / Google Pay,
Canadian pre-authorized debit, Interac e-Transfer, cheque or cash.

## Setup (once)

1. **Apply the migration** `supabase/migrations/20261004160000_invoices.sql` in the
   Supabase SQL editor (rollback: `supabase/rollback/20261004160000_invoices.down.sql`).
2. **Stripe Connect webhook** — the existing Connect endpoint
   (`/api/webhooks/stripe/connect`, "listen to events on connected accounts") must also
   be subscribed to:
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `charge.refunded`

   (`checkout.session.completed` and `account.updated` are already subscribed.)
      - `payment_intent.payment_failed`
   - `payment_intent.canceled`

   Without the async and payment-intent events, a bank debit can stay "clearing" forever.
3. **Bank debit (PAD)** — per brand: turn on *ACSS Debit* in that brand's Stripe
   dashboard (Settings → Payment methods), then switch on "Bank debit" in
   EmpireVu → Settings → Invoices.
4. **Per-brand settings** — EmpireVu → Settings → Invoices: HST/GST number, business
   address, invoice prefix, default terms and tax rate, e-Transfer address, cheque payee,
   reminder days.

No new environment variables. Reminders run in the existing daily
`job:quote-maintenance` cron (13:00 UTC = 9am Toronto); they now run even when
`STRIPE_QUOTES_ENABLED=0`.

## How it works

- **Invoices** (`invoices`) are per brand (company) with their own number series
  (`INV-2026-0001`, prefix configurable). Numbers are allocated on send, so drafts
  don't burn numbers.
- **Drafts can be half-finished**: no customer yet, no lines, blank descriptions, $0
  (migration `20261006120000_invoice_drafts.sql` limits the "needs a contact or account"
  check to non-drafts). `sendBlockers()` lists what's missing and `sendInvoice` refuses
  until it's empty ("Before sending: choose who it's for; give line 2 a description…").
  An issued invoice can't lose its customer or all its lines.
- **Send me a copy** (Settings → Invoices, per brand: `sendCopy`, `copyEmail` in
  `invoice_settings`): each send / resend also emails the same message + PDF to that
  address (blank = the organization owner's email), with a line on top saying how the
  customer got it. Its own email, not a BCC, so it arrives even when the customer was
  only texted. Logged as `copy_sent` / `copy_failed` on the invoice; never blocks the send.
- **Status** past `draft` is derived from payments by `refresh_invoice_balance()`
  (SQL): `sent → viewed → partially_paid → paid`, or `void`. Bank debits are
  `pending` until they clear and don't count as paid until then.
- **Quote → invoice** uses the customer's approved selection, carries a bundle saving
  as a discount line, and credits the paid deposit. Paying the invoice in full marks the
  quote `completed`. A quote or booking can only have one live (non-void) invoice.
- **Business accounts** (`customer_accounts`): a contact linked to an account bills
  the account ("Attn:" the contact), to its billing email, on its terms (e.g. Net 30).
  Statements (PDF + email) list one brand's open invoices for the account with aging.
- **Online payments** are direct charges on the brand's connected Stripe account
  (same as deposits). The invoice already itemizes HST, so Checkout does not compute
  tax again.
- **Reminders**: `invoice.overdue` fires once per invoice; reminder emails go out at
  the configured days past due (default 1, 7, 14), at most one per invoice per day.
  - **Custom wording** (`reminderSubject` / `reminderMessage` in `invoice_settings`,
    blank = built-in): `{first_name}`, `{customer_name}`, `{invoice_number}`,
    `{amount_due}`, `{due_date}`, `{days_overdue}`, `{company_name}`
    (`src/lib/reminder-template.ts`, shared with the settings preview). The summary
    table, pay button and offline payment lines are always appended. Used for overdue
    reminders only; a hand-sent reminder before the due date keeps "is due on …".
  - **Per invoice**: `invoices.reminders_paused` (staff-writable column grant) stops the
    automatic ones for that invoice (it still turns overdue). The detail API returns
    `reminders` (`reminderSchedule()`): state, next date, n of total, `canSendNow`.
  - **Send now**: `POST …/invoices/{id}/reminders/send` emails one immediately (even
    when paused). It does not advance `reminder_count`; it sets `last_reminder_at`
    (so the daily job skips that day) with a 2-minute double-click guard, and restores
    it if the email fails. Logged as `reminder_sent` with `manual: true` + the actor.
- **Opens** (migration `20261009120000_invoice_opens_reminders.sql`):
  - **Page**: every customer load of `/i/{token}` is counted by
    `record_invoice_view()` (service role; a reload within 30 min is the same open):
    `view_count`, `last_viewed_at`; the first sets `first_viewed_at` (→ status
    `viewed`) and emits `invoice.viewed` — bell + push ("payments" category) +
    automations. Logged as `viewed` with a coarse device label. Not counted: the
    brand's own signed-in members (cookie / bearer), headless browsers / bots / empty
    user agents (`invoices/opens.ts`), void invoices. The page's data comes from a JS
    API call, so link scanners that only fetch HTML don't count either.
  - **Email**: invoice and reminder emails to the customer (never the owner's copy)
    carry a 1×1 GIF on the brand's own origin,
    `/api/public/invoices/{token}/open?e=invoice|reminder-N`, recorded by
    `record_invoice_email_open()` (`email_open_count`, `first_/last_email_opened_at`,
    event `email_opened`). Never changes status, never alerts: Apple Mail Privacy
    Protection and some scanners load images on their own, and many clients block them.
  - No IP or location is stored. The privacy page lists invoice opens.
- **Automations**: new triggers `invoice.sent`, `invoice.viewed`, `invoice.paid`, `invoice.overdue`,
  `invoice.payment_failed`; templates can use `{{ invoice.number }}`,
  `{{ invoice.balance }}`, `{{ invoice.total }}`, `{{ invoice.due }}`,
  `{{ invoice.public_url }}`. Recipes: "Text me when an invoice is paid" (on),
  "Tell me when an invoice is overdue" (on), "Thank-you + review ask when paid"
  (draft — use it *or* "Review request", not both). Recipes install on new brands;
  existing brands add them from Automations → Recipes.
- **Job done → invoice** (Settings → Invoices, off by default): when a booking is
  marked completed, `invoices/auto.ts` creates a draft invoice or creates and sends
  it. A booking from a quote invoices the quote (deposit credited); a booking with no
  price stays a $0 draft and the owner gets a task — an unpriced invoice is never
  sent. A job that's already invoiced is skipped. Failures are logged, never block
  completing the job.
- Invoices and receipts are transactional messages: they're sent without marketing
  consent, but an SMS opt-out (STOP) is always honoured.

## Known limits

- One tax rate per invoice (no per-line tax / tax-exempt lines).
- Partial refunds are logged on the invoice timeline but don't change the balance;
  a full refund reopens it.
- Credit notes aren't a separate document; void and reissue instead.
