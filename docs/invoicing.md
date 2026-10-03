# Invoicing

Brands invoice customers and business accounts (marinas) from EmpireVu, convert
quotes and bookings into invoices, and get paid by card, Apple Pay / Google Pay,
Canadian pre-authorized debit, Interac e-Transfer, cheque or cash.

## Setup (once)

1. **Apply the migration** `supabase/migrations/20261004120000_invoices.sql` in the
   Supabase SQL editor (rollback: `supabase/rollback/20261004120000_invoices.down.sql`).
2. **Stripe Connect webhook** — the existing Connect endpoint
   (`/api/webhooks/stripe/connect`, "listen to events on connected accounts") must also
   be subscribed to:
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `charge.refunded`

   (`checkout.session.completed` and `account.updated` are already subscribed.)
   Without the two async events, bank debits stay "clearing" forever.
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
- **Automations**: new triggers `invoice.sent`, `invoice.paid`, `invoice.overdue`,
  `invoice.payment_failed`; templates can use `{{ invoice.number }}`,
  `{{ invoice.balance }}`, `{{ invoice.total }}`, `{{ invoice.due }}`,
  `{{ invoice.public_url }}`.
- Invoices and receipts are transactional messages: they're sent without marketing
  consent, but an SMS opt-out (STOP) is always honoured.

## Known limits

- One tax rate per invoice (no per-line tax / tax-exempt lines).
- Partial refunds are logged on the invoice timeline but don't change the balance;
  a full refund reopens it.
- Credit notes aren't a separate document; void and reissue instead.
