# AI staff

CrankLeads replaces everyone in the office except the owner. The AI front desk (docs/front-desk-ai.md) answers calls and texts; the AI staff roles below take the rest of the office jobs. They share the front desk's plumbing:

- **Owner by text** — every sensitive action is an `owner_approvals` row the owner answers with `Y 12` / `N 12` from the platform number.
- **One registry** — `src/server/services/staff/registry.ts` merges each role module (`staff/<role>/index.ts`, type `StaffRoleModule` in `staff/types.ts`) into:
  - the customer SMS agent (extra tools + prompt notes),
  - the owner-by-text agent (extra tools + prompt notes),
  - the approval runner (`owner-channel/approvals.ts` → the role's executor for its own kinds; the result is recorded on the row),
  - the scheduler (`runStaffSweeps`, each sweep throttled and isolated).
- **Settings** — Settings → AI front desk, one section per role (`src/components/settings/staff/*`), each role its own `companies.ai_settings.<section>` key.

Roles: Estimator, Bookkeeper, Dispatcher, Marketer — each section below is written by that role's builder.

## Estimator

## Bookkeeper

Gets invoices paid and keeps the owner's money picture straight. Code: `src/server/services/staff/bookkeeper/`. Migration: `20261011110000_staff_bookkeeper.sql` (rollback in `supabase/rollback/`). Settings: Settings → AI front desk → **Bookkeeper** (`src/components/settings/staff/BookkeeperSettingsSection.tsx`).

**What the customer and owner see.** Jamie's invoice is 3 days late: a text from the business number, "Hi Jamie, it's Northshore Snow & Lawn. Just a friendly reminder that invoice INV-2026-0012 for $1,240.00 was due Oct 1. You can pay here: https://…/i/… Thanks!". Firmer at day 10 and 20, and at day 30 "…If it's easier, reply to set up a payment plan." Jamie replies "can I do 3 payments?" → the texting assistant asks Dana ("#4 Jamie Lee (705-555-0123) asks for a payment plan on INV-2026-0012 ($1,200.00 owing): 3 payments of $400.00 - Oct 16, Oct 30 and Nov 13. Y sets it up, texts them the plan and reminds them before each payment. … Reply Y 4 to approve, N 4 to skip."). Dana texts "Jones paid 500 by etransfer" → "#5 Record $500 e-Transfer from Bob Jones on INV-2026-0009? $740 will still be owing. Reply Y 5 to record it, N 5 to skip." At 8am, only when something needs her: "Money check for Northshore: Payment failed: … Now 30+ days overdue: … Not syncing to QuickBooks: …".

### Reminder texts (`reminders.ts`, `deliver.ts`, `texts.ts`)

Sweep `bookkeeper:reminder-texts`, every 15 min:

- **Schedule:** `reminderDays` (default **3, 10, 20, 30** days past due, between the email reminders' default 1, 7, 14). Tone by step: gentle → nudge → firm → last (firm + "reply to set up a payment plan"). Texts are built in code: plain GSM, the business's name, the pay link (`/i/{token}` on the brand's quote host; the CrankLeads domain for CrankLeads orgs). Never anything beyond "final reminder": no legal threats, agencies, fees or credit talk (tested).
- **When:** 09:00–20:00 company local, **Monday–Saturday** only. At most one scheduled text per invoice per **5 days**, one Bookkeeper text per customer per **20 h**, never on a day a reminder (email or text) already went out.
- **Coordination with email:** every text stamps `invoices.last_reminder_at`, which the email sweep (`invoices/reminders.ts`) already reads as "reminded today", so an email and a text never land on the same day. A Bookkeeper **hold** (promise to pay / payment plan, `invoice_collections.hold_until`) pauses the email reminders too (`hold.ts`, one check in the email sweep; tolerant: no table → no hold).
- **Skipped:** `reminders_paused` invoices, money clearing for the whole balance, opted-out contacts, no consent, a conversation the owner took over in the last 14 days (or paused), invoices more than 150 days late, house orgs (default off).
- **Consent (CASL):** an invoice the customer owes is an existing business relationship, dated when the invoice was sent. The consent anchor is the later of the contact's own consent and that date, passed to `deliverMessage` as `consentContact` (opt-out and the consent window are enforced there, so a broader `checkConsent` applies automatically).
- **No backlog:** an invoice that's 40 days late when texts are switched on gets the day-30 text once, not four.
- **Exactly once:** every text is an `invoice_reminder_texts` row, unique `(invoice_id, reminder_key)` (`step:N`, `final`, `manual:<approval>`, `plan:<plan>:<n>`), inserted as the claim before sending. Owner-approved texts are inserted `queued` and sent right away inside the window, else by the next sweep inside it (`queued → claimed` is conditional). An approved text whose balance changed since the owner saw it is not sent, and the owner is told.
- **Final notice:** a week after the last scheduled text's day (default day 37), if still unpaid, the sweep claims `invoice_collections.final_notice_status` none → proposed and asks the owner (`collections_final_notice`). It is proposed once; a no or an expiry is final.
- **Instalments:** each active payment plan gets a text the day before (or the day of) each payment that isn't already covered by what's been paid since the plan started. A paid-off or voided invoice closes the plan and lifts the hold.

### Approvals (`approvals.ts`)

| Kind | Asked by | Owner sees | Y | N / expiry |
| --- | --- | --- | --- | --- |
| `collections_final_notice` (TTL 3 days) | reminder sweep | `Final notice for Jamie Lee (705-555-0123): INV-2026-0012, $1,240 owing, 40 days overdue, 4 reminder texts sent. Y texts them exactly: "Hi Jamie, this is a final reminder from Northshore Snow & Lawn: invoice INV-2026-0012 for $1,240.00 is now 40 days past due. Please pay here: … or reply to arrange a payment plan."` | That exact text (queued for 9am if after hours) → "Sent the final notice to Jamie Lee." | No final notice; the automatic texts for that invoice are done |
| `payment_plan` (24 h) | SMS agent `request_payment_plan` | who, invoice, balance, "3 payments of $400.00 - Oct 16, Oct 30 and Nov 13", the customer's words | `payment_plans` row, hold through the last date, the customer gets the plan + pay link, reminders before each payment | N: "Dana will be in touch with you directly about the payment" + conversation to the owner. Expiry: conversation to the owner, no customer text |
| `record_payment` (24 h) | owner tool `record_offline_payment` | `Record $500 e-Transfer from Bob Jones on INV-2026-0009? $740 will still be owing.` | `invoices/service.ts recordPayment` (receipt email as usual), once: the approval id is in the payment's notes | Nothing recorded |
| `send_invoice_reminder` (12 h) | owner tool `remind_now` | `Text Jamie Lee (705-555-0123) about INV-2026-0012 ($1,240, 12 days late)? They'll get exactly: "…"` | That exact text (queued for 9am if after hours) | Nothing sent |

Sweep-created approvals are texted by `notifyOwnerOfApproval` (quiet hours respected). Owner-tool approvals are asked inline: the row is inserted already `notified_to` the owner's phone, and the owner agent replies with the tool's `tell_owner` text ("#5 … Reply Y 5 to record it, N 5 to skip."). None of these kinds takes a price; a note that isn't the amount shown means nothing is done, and the owner is told how to start again.

### SMS agent tools (`agent-tools.ts`)

| Tool | Does |
| --- | --- |
| `my_invoices` | This contact's open invoices (number, owing, due, days late). `send_link: true` adds the pay link(s) to the reply. The amounts are vouched for the reply guard. |
| `promise_to_pay` | A date from today to 30 days out → an `invoice_collections` promise + a hold through that date (reminders resume the day after). Missed → flagged in the morning alert. |
| `request_payment_plan` | 2–6 equal payments (leftover cents on the last), weekly / every 2 weeks / monthly, the first within 30 days, all within 6 months → a `payment_plan` approval. One open request per customer. |

Prompt notes: only state amounts the tool returned; promise dates → `promise_to_pay`; never promise a plan, a discount or a consequence; disputes, "wrong amount", refunds and "I already paid" → `hand_off_to_owner`. When the Bookkeeper is off for the company (the house-org default), the tools tell the agent to hand bill questions to the owner.

### Owner tools (`owner-tools.ts`)

- `who_owes_me`: outstanding, overdue, aging 0–30 / 31–60 / 61–90 / 90+ (0–30 includes not-yet-due), and the top 5 owing.
- `cash_snapshot`: collected this week (from local Monday) and this month (succeeded invoice payments + quote deposits), outstanding, overdue, deposits expected on approved quotes.
- `record_offline_payment`: etransfer / cheque / cash / card / other, optional date and reference. Refuses more than is owing; several matches → asks which.
- `remind_now`.

Invoices are matched by id, number or customer name inside the owner's company only.

### Daily owner money alert (`daily-alert.ts`)

Sweep `bookkeeper:money-alert`, every 10 min. A company is considered from 08:00 to 10:59 local (catch-up if a worker was down). At most one text a day, from the platform number to the verified owner cell, and only when something new is notable:

- an invoice crossed **30** or **60** days overdue;
- a payment **failed** (in the last 48 h; payments staff removed as a mistake don't count);
- a **promise to pay** was missed (marked `missed`; `kept` once the invoice is paid), or a **plan instalment** is 2+ days late and not covered;
- the **accounting sync** is failing for an invoice or payment (`accounting_sync_jobs` failed, or pending after 3+ attempts);
- **reconciliation:** an invoice marked paid in the last 90 days with no succeeded payment (and no credit covering it); a succeeded payment more than 24 h old (after the connection's start) with no `accounting_links` row and no job in flight, while a connection is active.

The day is claimed first (`money_alerts`, unique company + local date), and each item is told once (`money_alert_items`, unique company + key). A failed send forgets the day's items so tomorrow's alert carries them. The text is ≤ 600 characters, grouped by kind, ending `Text "who owes me" for the full list.`

### Weekly report

One optional line in the email, "Still owed to you: $X ($Y overdue (N invoices))", from the open invoices when the report is made (`weekly-report/metrics.ts` `receivable`, a tolerant read; no line when nothing is owed). The text message is unchanged.

### Settings (`settings.ts`, route, UI)

`companies.ai_settings.collections = { enabled?, textReminders?, reminderDays?, finalNotice?, dailyAlert? }`. `enabled` defaults **on** for CrankLeads orgs and **off** for house orgs (A1: nothing changes unless it's switched on). The rest default on; `reminderDays` defaults to [3, 10, 20, 30] (1–6 days in 1..120). Route: `GET|PATCH /api/organizations/:org/companies/:company/ai-settings/collections` (members read; owners/admins PATCH with a strict schema, merging only `collections` via `updateAiSettings`). The UI shows what's owed, texts sent in 30 days, plans and promises, the email schedule it works around, and a warning when no verified owner cell is on file.

### Data (migration `20261011110000_staff_bookkeeper.sql`)

- `invoice_collections`: one per invoice (text step, last text, hold, promise, final notice).
- `invoice_reminder_texts`: every reminder text (the claim).
- `payment_plans`: one active per invoice; unique per approval.
- `money_alerts`, `money_alert_items`.

RLS: members read the first four; `money_alert_items` is service role only; no client writes. Local row types are in `staff/bookkeeper/db-types.ts` (not in `database.types.ts`). Its texts carry `message_log.sent_by = 'bookkeeper'`.

No env vars and no model calls of its own: every text is built in code, and the conversations run through the SMS agent's model.

Tests: `src/test/staff-bookkeeper.test.ts` (money formatting, settings defaults, window + schedule, consent, the sweep against the fake DB incl. idempotency and quiet hours, every approval kind through `decideApproval`, the tools, the alert, the route, the weekly line).

## Dispatcher

## Marketer
