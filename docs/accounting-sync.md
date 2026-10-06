# QuickBooks Online / Xero sync

One-way sync from EmpireVu into the business's accounting file, per company (brand):
sent invoices (with their customer), payments, refunds and voids, and expenses with
their receipt files. Owners/admins connect in **Settings → Accounting**.

Migration `20261005200000_accounting_sync.sql` (rollback in `supabase/rollback/`).

## Setup (once per server)

| Env (web + worker) | |
| --- | --- |
| `ACCOUNTING_TOKEN_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored tokens (AES-256-GCM) and signs the OAuth state. **Required.** Changing it forces every company to reconnect. |
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | From developer.intuit.com → your app → Keys & credentials. |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` while testing; `production` (default) once Intuit approves the app. |
| `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` | From developer.xero.com → My Apps (Web app). |
| `XERO_SCOPES` | Optional override. Default: the granular scopes (`accounting.invoices accounting.payments accounting.banktransactions accounting.contacts accounting.settings.read accounting.attachments` + `openid profile email offline_access`) — required for Xero apps created after 2 Mar 2026. |
| `ACCOUNTING_REDIRECT_BASE_URL` | Optional; defaults to `APP_BASE_URL`. |

Redirect URIs to register:

- QuickBooks: `https://app.empirevu.com/api/accounting/callback/quickbooks`
- Xero: `https://app.empirevu.com/api/accounting/callback/xero`

A provider is offered in Settings only when its id/secret and `ACCOUNTING_TOKEN_KEY` are set.
`npm run job:accounting-sync` runs a sync pass by hand (the worker does it every minute).

## How it works

```
invoices / invoice_payments / expenses ──(DB triggers, only if the company is connected)──▶ accounting_sync_jobs
                                                                                                   │
worker scheduler pass (≈ every minute) ── claim_accounting_sync_jobs (skip-locked) ─▶ engine.ts ─▶ QuickBooks / Xero
                                                                                                   │
                                                                         accounting_links (EmpireVu id ↔ remote id + hash)
```

- **Triggers** fire only on changes that matter to the books (e.g. not on a notes edit) and
  coalesce: one pending job per record. Drafts never sync.
- **Links** make every push an update, never a duplicate. An unchanged record (same payload
  hash) makes no API call. Links are kept per file, so disconnecting and reconnecting the
  same file carries on where it left off.
- **Start date**: records dated before it are skipped (so books already entered by hand aren't
  duplicated). Saving the mapping queues everything from the start date not yet synced.
- **Dependencies**: a payment pushes its invoice first; an invoice finds-or-creates its
  customer (by name — a name already linked to a different EmpireVu customer gets "Name
  (email)"); an expense its vendor (Xero needs a contact on every spend; QuickBooks doesn't).
- **Deposits**: an online-booking deposit was its own invoice, so the job invoice gets a
  negative, untaxed "Deposit received" line. A quote deposit (paid before any invoice) is
  booked as a payment on the invoice.
- **Tax**: EmpireVu's one rate is split across the taxed lines (exact to the cent). Xero gets
  our per-line tax amounts, so totals match exactly. QuickBooks computes its own (TaxExcluded
  with the chosen code); a different total is noted on the link and shown in Activity. US
  QuickBooks files use TAX/NON and QuickBooks' sales tax; expenses there go over at full cost.
- **Receipts** are attached once (QuickBooks Attachable / Xero attachment); a failed attachment
  is noted, never fails the expense.
- **Refunds / removed payments** delete the payment in the file; a voided invoice is voided.
  Expenses deleted or moved to another company are deleted from the file.
- **Errors**: rate limits / outages back off (1 min doubling to 6 h, honouring Retry-After;
  6 attempts). A mapping problem fails at once with a message saying what to choose. A dead
  sign-in pauses that company (status `needs_reauth`, "Reconnect" in Settings); reconnecting
  the same file re-queues the paused work.
- **Tokens** are encrypted, service-role only (`accounting_tokens`, no RLS policies). Both
  providers rotate refresh tokens: the new pair is saved before use, and refreshes are
  serialized by `claim_accounting_token_refresh` (a SQL function — a filtered PATCH can't be
  used for the lock, because PostgREST re-applies the filter to the returned row).

## Files

| | |
| --- | --- |
| Pure mapping / suggestions | `src/server/services/accounting/mapping.ts`, `suggest.ts`, `types.ts` |
| Providers | `providers/quickbooks.ts` (API v3, minorversion 75), `providers/xero.ts` |
| Tokens / OAuth | `tokens.ts`, `crypto.ts`, `config.ts` |
| Engine (worker) | `engine.ts`, hooked in `workflow-engine/scheduler.ts`; `src/server/jobs/accounting-sync.ts` |
| Settings service + routes | `connections.ts`; `/api/organizations/{org}/accounting/{company}` (+ `/connect`, `/disconnect`, `/options`, `/sync`, `/state`); `/api/accounting/callback/{provider}` |
| UI | `src/components/settings/AccountingSettings.tsx`, `src/components/accounting/SyncBadge.tsx`, `src/lib/accounting-api.ts` |
| Tests | `src/test/accounting-sync.test.ts` |

## Going live with QuickBooks

Intuit gives sandbox keys instantly. Production keys need the app's production settings
(EULA + privacy policy URLs, host domain, the redirect URI above) and Intuit's app assessment
questionnaire. Until then use `QUICKBOOKS_ENVIRONMENT=sandbox` with a sandbox company.
