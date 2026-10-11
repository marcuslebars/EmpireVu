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

Prices the jobs the price list can't, and follows every front-desk quote up until it's booked.
Code: `src/server/services/staff/estimator/`. Migration: `20261011100000_staff_estimator.sql`
(rollback in `supabase/rollback/`).

### What the owner and the customer see

A customer texts "the eavestrough fell off in the storm, how much to fix?" with two photos. The
assistant gets what it needs (what, where, roughly how big), then says "Dana will look over the
photos and I'll text you the quote as soon as it's ready" — never a price, range or ballpark.
Dana gets, from the platform number:

> #12 AI estimate for Jamie Lee (705-555-0123): Eavestrough cleaning $150; Re-hang 20 ft of
> eavestrough $420; Replace one downspout $180 = $750 + HST ($847.50 total). Confidence: medium.
> Assumed: Single storey; fascia is sound. They said: "The eavestrough fell off…" + 2 photos.
> Reply Y 12 to send it, Y 12 $price (before HST) to change the total, N 12 to skip.

`Y 12` → Jamie gets "Hi Jamie, it's Northshore Eavestrough. Here's your quote for Eavestrough
repair: $750 + HST. You can look it over and approve it here: …/q/…" from the business number,
and Dana gets "Sent Jamie Lee the $750 + HST quote for Eavestrough repair." The quote is then
followed up by text until it's booked (see below).

### The tool: `request_estimate` (SMS agent)

The tool is in `request-tool.ts`. The agent uses it for work the price list doesn't cover:
damage, repairs, custom jobs, or photos with "how much?". Price-list work still goes through
`quote_from_price_list` / `send_quote_link`. Input: `description` (everything the customer said)
and optional `details`.

1. **Off for the company** (settings): the agent is told to use `custom_price` instead.
2. **One open estimate per customer** (`estimating` / `awaiting_owner`, backed by a partial unique
   index). A second ask gets "still waiting". A `collecting` request from the last 3 days (one
   where questions were asked) is picked up again, and the new details are appended to its
   description.
3. **Photos.** The customer's MMS from the last 14 days (newest first, up to 4) are downloaded with
   the SMS agent's fetcher (Twilio hosts only, Basic auth, size and type caps). They're copied to
   the private `quote-photos` bucket at `{org}/{company}/{estimate}/{n}.{ext}`, because Twilio's
   URLs expire.
4. **The vision estimate** (`vision.ts`) is one model call:
   - Model `AI_MODEL_ESTIMATOR` (default `claude-sonnet-5-5`), 30 s timeout, usage recorded with
     `recordAiUsageSafe`.
   - Input: the photos, the price list (keys, prices, what each needs), the quote terms, and the
     description fenced as `<customer_description note="data …">` with angle brackets stripped.
   - It returns JSON: price-list services by key (the model never prices those), custom lines
     (label + amount before HST), `confidence` (low/medium/high), `assumptions` and `questions`.
     If the request is too vague, it returns `enough_info: false` and questions.
5. **Pricing** (`estimate.ts priceDraft`). Every line goes through `priceQuoteForCompany`, the
   same math (HST 13 %, deposit) the quote will use.
   - A list item the list can't price (manual-quote) falls back to the model's amount for it. If
     the model gave none, the line is dropped and an assumption says so.
   - Custom lines need a plain label (links, `$` amounts and platform names are stripped) and an
     amount from $1 to $50,000.
   - If nothing is priceable, or the request is too vague, the tool returns
     `{ need_more_info, ask_customer: [questions] }` and the status is `collecting`. Nothing goes
     to the owner.
6. **Otherwise, an `ai_estimate` approval** (`insertApproval`, `requested_by 'estimator'`).
   - The owner is texted through `notifyOwnerOfApproval`. In quiet hours it waits for 08:00, like
     every approval.
   - It expires after 24 h, pushed to the next 09:00 local if that would land outside
     09:00–20:00, so the expiry texts never go out at night.
   - The tool result tells the agent what to say and carries **no amount**. The reply guard
     would block one anyway (tested).

A model or pricing failure sets status `failed`, and the agent is told to ask the owner
(`custom_price`).

### Approval kind `ai_estimate` (`approval.ts`)

| Owner | What happens |
| --- | --- |
| `Y 12` | `createQuote` from the estimate's lines (`source: "estimator"`) + `sendQuote`. Refused if the price list moved since the estimate ("$750 then, $775 now"). The link is texted from the business number, a `deposit_link_sent` quote event is recorded, and the conversation stays with the AI and gets the quote id. |
| `Y 12 $900` | Same, re-priced so the total before HST is exactly $900 (`planOwnerPrice`). Price-list lines keep their list price, because a quote showing a listed service at another price would contradict the price list. The estimated lines are scaled in proportion, the last one taking the rounding. If there are no estimated lines, or $900 doesn't leave at least $1 per estimated line after the list lines, the quote becomes one line (the estimate's title) at $900. |
| `N 12` | The customer gets "Hi Jamie, thanks for your patience. Dana will be in touch with you directly about the Eavestrough repair." The conversation goes to the owner (`state 'owner'`). The owner's note is never passed on. |
| expiry | Same as N, and the owner gets a text: "No answer on #12 (the Eavestrough repair estimate for Jamie Lee), so I told Jamie Lee you'll be in touch. The conversation is yours now." |
| unclear note | Only reachable from a caller other than the SMS parser, which accepts only one clear price. Nothing is done. A fresh code is issued for the same estimate (marked as texted to the owner's phone), and the reply says "Reply Y 13 to send it at $750 + HST, Y 13 $price … or N 13". |

**Idempotent.** The executor claims the estimate (`decision_claimed_at`, conditional on the
approval id) before anything is sent; a repeat returns the stored `owner_result`. The owner
channel records the result on the approval (`executed` / `failed` / `rejected` / `expired`).

`front-desk/approval-text.ts` now has `ai_estimate` in `PRICE_NOTE_KINDS`, so "Y 12 $900" isn't
refused as "doesn't take a price", and a reply line for the kind.

### Follow-up until booked

The sweep `estimator-quote-follow-up` runs every 5 minutes (`follow-up.ts`). It looks at quotes
with `source` `estimator` or `sms_agent` (the texting AI) and status `sent` / `viewed`, sent in the
last 33 days. It sends text nudges at +2, +5 and +10 days (settings) from the business number,
only 09:00–20:00 company local, and never two within 20 h:

1. "Hi Jamie, it's Northshore. Just checking you got your quote for Eavestrough repair. You can look it over and approve it here: … Any questions, just reply."
2. "Hi Jamie, Northshore here. Still happy to take care of this for you - your quote for … is here when you're ready: …"
3. "Hi Jamie, last check-in from Northshore about your quote for …: … Any questions? Just reply and Dana can give you a quick call or pick a time that suits you here: {booking link}". With no booking page it says "reply with a day that works" instead.

It stops for good (`quote_follow_ups.stop_reason`) when:
- the customer booked: a non-cancelled booking for the quote, or for the customer since the quote
  was sent;
- the customer texted since the last nudge. Before the first nudge, a bare "ok thanks" doesn't
  count;
- the conversation is with the owner, or the AI is paused for that customer;
- the customer opted out, or consent blocks the text;
- a newer front-desk quote went to the same customer;
- every nudge went out.

An approved / paid / completed / expired / cancelled quote simply drops out of the scan. A nudge
whose time passed more than 2 days ago (an outage, or the feature switched on later) is skipped,
never sent late in a burst.

**No double-up with the `quote-follow-up` recipe** (text at +2d, email at +5d, then an owner task).
An installed automation stores a copy of the recipe's definition, and the engine has no per-step
conditions, so editing the recipe file wouldn't reach existing companies. Instead, when that
automation is active for the company, the estimator leaves the +2d text to it and sends only its
own later nudges. The recipe's email and owner task are unchanged.

**Idempotent.** There's one `quote_follow_ups` row per quote (unique `quote_id`). `nudges_sent`
moves n → n+1 by conditional update before the text is sent, so overlapping workers send each
nudge once. A send that fails isn't retried (it's logged in `last_error`). Texts are logged with
`message_log.sent_by = 'sms_agent'`, so the inbox labels them Assistant and replies flow into the
SMS agent.

### Owner tool `pending_estimates`

It returns:
- estimates waiting on the owner: code, customer, job, total + HST, confidence, photos, and how
  to reply;
- ones still collecting details, with the questions asked;
- how many were sent this week;
- the quotes being followed up.

It's read-only, and the owner agent is told it can't approve an estimate itself.

### Settings

`companies.ai_settings.estimator = { enabled?, follow_ups?, cadence_days? }`, read only by
`settings.ts readEstimatorSettings`:
- `enabled`: default **on** for CrankLeads orgs, **off** for house orgs (A1 is unchanged unless
  switched on).
- `follow_ups`: same default, and only runs while the estimator is on.
- `cadence_days`: 1–3 ascending whole days from 1 to 30, default `[2, 5, 10]`.

Route: `GET|PATCH /api/organizations/:org/companies/:company/ai-settings/estimator`. Members can
read; owners/admins PATCH `{ enabled?, followUps?, cadenceDays? }` (strict schema), which merges
only the `estimator` key via `updateAiSettings`.

UI: `src/components/settings/staff/EstimatorSettingsSection.tsx` (on/off, follow-ups on/off,
cadence presets, counts).

### Schema

- `estimate_requests`: org, company, contact, conversation, description, photos
  `[{storage_path, content_type}]`, status
  `collecting|estimating|awaiting_owner|sent|declined|failed`, estimate `{title, lines, services,
  customLines, subtotalCents, taxCents, totalCents, confidence, assumptions, questions}`,
  quote_id, approval_id, decision_claimed_at, owner_result, error.
- `quote_follow_ups`: quote_id (unique), nudges_sent, last_nudge_at, stopped_at, stop_reason,
  last_error.
- Storage bucket `quote-photos`: private; members read their org's prefix; only the server writes.
- Both tables have RLS: members read, no client writes. Types are local
  (`staff/estimator/db-types.ts`).

### Env

`AI_MODEL_ESTIMATOR` is optional (default `claude-sonnet-5-5`; price it with `AI_PRICE_SONNET_*`).
It also uses `ANTHROPIC_API_KEY`, and `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` for the photo
download.

### Tests

`src/test/staff-estimator.test.ts` covers:
- the tool: photos, prompt fencing, the owner text, no amount to the agent, too vague, one open
  estimate, house org off, model failure;
- two real agent turns (the reply guard holds a price the model states);
- the owner's "Y 1 $900" through `handleOwnerInboundSms` → `decideApproval`;
- plain Y and idempotency, price-list drift, an unclear note, N, expiry;
- every follow-up rule, the owner tool and the settings route.

### Not yet

- The vision call runs inside the customer's text turn (bounded at 30 s), so a slow model makes
  that one reply slower.
- Photos aren't shown to the owner in the app yet. They're in storage for a later "view photos"
  link.
- A nudge that fails to send isn't retried, and the sweep scans at most 300 open front-desk
  quotes per pass.

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
