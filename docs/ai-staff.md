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

> #12 AI estimate for Jamie Lee (705-555-0123) - quote "Eavestrough repair": Eavestrough cleaning
> $150; Re-hang 20 ft of eavestrough $420; Replace one downspout $180 = $750 + HST ($847.50 total).
> Confidence: medium.
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
   index). Asking again about the same job (`same_job: true`) gets "still waiting". A different
   job while one is open is refused, and the agent is told to use `request_owner_approval`
   (`custom_price`) or `hand_off_to_owner` for it, so it never promises a quote that isn't coming.
   A `collecting` request from the last 3 days (one where questions were asked) is reused only
   when the agent passes `answers_to_questions: true`; the answers are appended to its
   description. Otherwise the old request is closed and a new one starts.
   Stuck rows don't block the customer: `estimating` older than 5 minutes (a crash mid-estimate)
   and `awaiting_owner` whose approval is no longer pending are marked `failed` and ignored.
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
   - Custom lines need a plain label and an amount from $1 to $50,000. Labels and the quote title
     are customer-facing, so links, `$` amounts, percentages, platform names and deal words
     ("free", "discount", "10 off", "half off", "as agreed", "promo") are stripped. A bare "off"
     stays ("take off old shingles").
   - If nothing is priceable, or the request is too vague, the tool returns
     `{ need_more_info, ask_customer: [questions] }` and the status is `collecting`. Nothing goes
     to the owner.
6. **Otherwise, an `ai_estimate` approval** (`insertApproval`, `requested_by 'estimator'`).
   - The estimate is linked to the approval before the owner is asked; if that write fails, the
     approval is withdrawn (`superseded`) so a "Y" can never land on nothing.
   - The owner is texted through `notifyOwnerOfApproval`. In quiet hours it waits for 08:00, like
     every approval.
   - It expires after 24 h, pushed to the next 09:00 local if that would land outside
     09:00–20:00, so the expiry texts never go out at night.
   - The owner's text always keeps who, the quote title (customer-facing, so the owner sees it),
     the total + HST and the confidence. Lines get a budget; extra lines fold into
     "+N more lines ($Z)", then assumptions and the customer's words fill what's left (≤ 480).
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
approval id) before anything is sent; a repeat returns the stored `owner_result`. If no estimate
points at the approval any more, the owner is told "#12 isn't linked to an estimate any more, so
nothing was sent". The owner
channel records the result on the approval (`executed` / `failed` / `rejected` / `expired`).

`front-desk/approval-text.ts` now has `ai_estimate` in `PRICE_NOTE_KINDS`, so "Y 12 $900" isn't
refused as "doesn't take a price", and a reply line for the kind.

### Follow-up until booked

The sweep `estimator-quote-follow-up` runs every 5 minutes (`follow-up.ts`). It looks at quotes
with `source` `estimator` or `sms_agent` (the texting AI) and status `sent` / `viewed`, sent in the
last 33 days, keyset-paged by `sent_at` (500 a page, up to 20 pages), so new quotes are never
starved. Each company is checked once per pass: disabled and house-org companies, companies
outside 09:00–20:00, and companies whose business facts can't load are skipped before any
per-quote work, and quotes whose follow-up already stopped are skipped. Each pass also closes
follow-up rows whose quote is no longer sent/viewed (`stop_reason 'quote_closed'`), so the
Settings and `pending_estimates` counts stay right. It sends text nudges at +2, +5 and +10 days (settings) from the business number,
only 09:00–20:00 company local, and never two within 20 h:

1. "Hi Jamie, it's Northshore. Just checking you got your quote for Eavestrough repair. You can look it over and approve it here: … Any questions, just reply."
2. "Hi Jamie, Northshore here. Still happy to take care of this for you - your quote for … is here when you're ready: …"
3. (the last nudge, whatever the cadence length) "Hi Jamie, last check-in from Northshore about your quote for …: … Any questions? Just reply and Dana can give you a quick call or pick a time that suits you here: {booking link}". With no booking page it says "reply with a day that works" instead.

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

`estimatorActiveFor(admin, { organizationId, companyId })` (`settings.ts`) is true when the
estimator is enabled for that company; the registry wiring uses it to offer `request_estimate`
and the prompt notes only there. The notes are worded "If request_estimate is available…".

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
- A nudge that fails to send isn't retried. The sweep visits at most 10,000 open front-desk
  quotes per pass.

## Bookkeeper

Gets invoices paid and keeps the owner's money picture straight. Code: `src/server/services/staff/bookkeeper/`. Migration: `20261011110000_staff_bookkeeper.sql` (rollback in `supabase/rollback/`). Settings: Settings → AI front desk → **Bookkeeper** (`src/components/settings/staff/BookkeeperSettingsSection.tsx`).

**What the customer and owner see.** Jamie's invoice is 3 days late: a text from the business number, "Hi Jamie, it's Northshore Snow & Lawn. Just a friendly reminder that invoice INV-2026-0012 for $1,240.00 was due Oct 1. You can pay here: https://…/i/… Thanks!". Firmer at day 10 and 20, and at day 30 "…If it's easier, reply to set up a payment plan." Jamie replies "can I do 3 payments?" → the texting assistant asks Dana ("#4 Jamie Lee (705-555-0123) asks for a payment plan on INV-2026-0012 ($1,200.00 owing): 3 payments of $400.00 - Oct 16, Oct 30 and Nov 13. Y sets it up, texts them the plan and reminds them before each payment. … Reply Y 4 to approve, N 4 to skip."). Dana texts "Jones paid 500 by etransfer" → "#5 Record $500 e-Transfer from Bob Jones on INV-2026-0009? $740 will still be owing. Reply Y 5 to record it, N 5 to skip." At 8am, only when something needs her: "Money check for Northshore: Payment failed: … Now 30+ days overdue: … Not syncing to QuickBooks: …".

### Reminder texts (`reminders.ts`, `deliver.ts`, `texts.ts`)

Sweep `bookkeeper:reminder-texts`, every 15 min. It first loads the companies with the Bookkeeper on (every company of a CrankLeads org unless switched off, plus house-org companies whose `ai_settings.collections.enabled` is true, filtered at the query; `loadActiveCompanies`), then reads each company's own overdue invoices and plans in 1000-row pages. A read error for a company (e.g. its collections state) skips that company for the run, never texting without its holds:

- **Schedule:** `reminderDays` (default **3, 10, 20, 30** days past due, between the email reminders' default 1, 7, 14). Tone by step: gentle → nudge → firm → last (firm + "reply to set up a payment plan"). Texts are built in code: plain GSM, the business's name, the pay link (`/i/{token}` on the brand's quote host; the CrankLeads domain for CrankLeads orgs). Never anything beyond "final reminder": no legal threats, agencies, fees or credit talk (tested).
- **When:** 09:00–20:00 company local, **Monday–Saturday** only. At most one scheduled text per invoice per **5 days**, one Bookkeeper text per customer per **20 h**, never on a day a reminder (email or text) already went out.
- **Coordination with email:** every text stamps `invoices.last_reminder_at`, which the email sweep (`invoices/reminders.ts`) already reads as "reminded today", so an email and a text never land on the same day. A Bookkeeper **hold** (promise to pay / payment plan, `invoice_collections.hold_until`) pauses the email reminders too (`hold.ts`, one check in the email sweep; tolerant: no table → no hold).
- **Skipped:** `reminders_paused` invoices, money clearing for the whole balance, opted-out contacts, no consent, a conversation the owner took over in the last 14 days (or paused), invoices more than 150 days late, house orgs (default off).
- **Consent (CASL):** an invoice the customer owes is an existing business relationship, dated when the invoice was sent. The consent anchor is the later of the contact's own consent and that date, passed to `deliverMessage` as `consentContact` (opt-out and the consent window are enforced there, so a broader `checkConsent` applies automatically).
- **No backlog:** an invoice that's 40 days late when texts are switched on gets the day-30 text once, not four.
- **Exactly once:** every text is an `invoice_reminder_texts` row, unique `(invoice_id, reminder_key)` (`step:N`, `final`, `manual:<approval>`, `plan:<plan>:<n>`), inserted as the claim before sending. Owner-approved texts are inserted `queued` and sent right away inside the window, else by the next sweep inside it (`queued → claimed` is conditional). An approved text whose balance changed since the owner saw it is not sent, and the owner is told.
- **Final notice:** a week after the last scheduled text's day (default day 37), if still unpaid, the sweep claims `invoice_collections.final_notice_status` none → proposed and asks the owner (`collections_final_notice`). It is proposed once; a no or an expiry is final.
- **Instalments:** each active payment plan gets a text the day before (or the day of) the next payment that isn't already covered by what's been paid since the plan started; a missed payment doesn't silence the later ones. While the plan is on track it holds the other reminders through its last date; once a payment is 2+ days late and uncovered, the hold is lifted (the normal reminders resume and the morning alert flags it), and it returns if the customer catches up. A paid-off or voided invoice closes the plan and lifts the hold.
- **Failures:** a step is used up only by a text that went out (a failed or blocked one keeps its row, so it's never sent twice, and the next step's day brings a fresh one). A claim is released if the run throws before the send; a final-notice proposal goes back to `none` if its approval couldn't be created.

### Approvals (`approvals.ts`)

| Kind | Asked by | Owner sees | Y | N / expiry |
| --- | --- | --- | --- | --- |
| `collections_final_notice` (TTL 3 days) | reminder sweep | `Final notice for Jamie Lee (705-555-0123): INV-2026-0012, $1,240 owing, 40 days overdue, 4 reminder texts sent. Y texts them exactly: "Hi Jamie, this is a final reminder from Northshore Snow & Lawn: invoice INV-2026-0012 for $1,240.00 is now 40 days past due. Please pay here: … or reply to arrange a payment plan."` | That exact text (queued for 9am if after hours) → "Sent the final notice to Jamie Lee." | No final notice; the automatic texts for that invoice are done |
| `payment_plan` (24 h) | SMS agent `request_payment_plan` | who, invoice, balance, "3 payments of $400.00 - Oct 16, Oct 30 and Nov 13", the customer's words | `payment_plans` row, hold through the last date, the customer gets the plan + pay link (queued for 9am if decided outside 9am-8pm Mon-Sat), reminders before each payment | N: "Dana will be in touch with you directly about the payment" (same send window) + conversation to the owner. Expiry: conversation to the owner, no customer text |
| `record_payment` (24 h) | owner tool `record_offline_payment` | `Record $500 e-Transfer from Bob Jones on INV-2026-0009? $740 will still be owing.` | `invoices/service.ts recordPayment` (receipt email as usual), once: the approval id is in the payment's notes | Nothing recorded |
| `send_invoice_reminder` (12 h) | owner tool `remind_now` | `Text Jamie Lee (705-555-0123) about INV-2026-0012 ($1,240, 12 days late)? They'll get exactly: "…"` | That exact text (queued for 9am if after hours) | Nothing sent |

Sweep-created approvals are texted by `notifyOwnerOfApproval` (quiet hours respected). Owner-tool approvals are asked inline: the row is inserted already `notified_to` the owner's phone, and the owner agent replies with the tool's `tell_owner` text ("#5 … Reply Y 5 to record it, N 5 to skip."). None of these kinds takes a price; a note that isn't the amount shown means nothing is done, and the owner is told how to start again.

### SMS agent tools (`agent-tools.ts`)

| Tool | Does |
| --- | --- |
| `my_invoices` | This contact's open invoices (number, owing, due, days late). `send_link: true` adds the pay link(s) to the reply. The amounts are vouched for the reply guard. |
| `promise_to_pay` | A real date from today to 30 days out → an `invoice_collections` promise + a hold through that date (reminders resume the day after; never more than 30 days from when it was recorded). One promise per invoice: a second date, or one after a missed promise, is refused and the agent hands off to the owner. Missed → flagged in the morning alert. |
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

The day is claimed first (`money_alerts`, unique company + local date), and each item is told once (`money_alert_items`, unique company + key). Every read is checked and large id lists are chunked (200); a failed read sends nothing and gives the day back so a later pass retries. A failed send forgets the day's items so tomorrow's alert carries them; a promise is only marked `missed` once an alert about it went out. Only companies with the Bookkeeper and the alert on are scanned (`loadActiveCompanies`). The text is ≤ 600 characters, grouped by kind, ending `Text "who owes me" for the full list.`

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

The Dispatcher runs the schedule around the weather and the crew: it proposes moving jobs when bad weather is coming (the owner OKs the batch), texts customers when the crew is on the way, texts each crew member their next day, and offers freed-up spots to customers booked later. Code: `src/server/services/staff/dispatcher/`. Migration: `20261011120000_staff_dispatcher.sql` (rollback in `supabase/rollback/`).

### What the owner and their customers experience

- **15:00, rain coming tomorrow.** The owner gets one text from the platform number: `#12 Weather: move these 2 jobs? Sam Lee roof repair Thu 9am to Fri 11am (rain 90%, 5 mm); Jo Park gutter cleaning Thu 1pm to Fri 9am (rain 90%, 2.5 mm). Each customer gets: "Hi Sam, it's Northshore Roofing. Rain is in the forecast for your roof repair on Thu Oct 15, so we've moved it to Fri Oct 16, 11:00 a.m. Need a different time? [their booking link]" Reply Y 12 to approve, N 12 to skip.` On **Y** each job moves and each customer gets that text with their own `/v/{manage_token}` link. On **N** nothing happens. Nothing ever moves without the owner's Y.
- **The crew taps "On my way"** on the job sheet. When the Dispatcher will text the customer (setting on, no "On my way" automation), the button asks for an ETA (10 / 20 / 30 / 45 min / 1 hr, or none); otherwise it stays a single tap (house orgs, A1). The customer gets: "Hi Sam, it's Northshore Roofing. Mike from our crew is on the way for your roof repair and should be there in about 20 minutes. See you soon!"
- **18:00 the night before**, each crew member with a cell on file gets: "Northshore Roofing - your jobs tomorrow (Thu Oct 15): 1) 9:00 a.m. - Sam - roof repair - 12 Bay St - https://maps.google.com/?q=…". If their day changes after that in a way that matters for jobs that haven't started (a job added, moved, cancelled, re-assigned, a new address — never a job heading out, starting, finishing or a no-show), they get "Northshore Roofing update - your jobs tomorrow (Thu Oct 15) changed: …", or "…you're no longer on any jobs tomorrow" ("…you have no more jobs today" on the day).
- **A job in the next 48 hours is cancelled or moved away** (from the app, the owner by text, or the customer's own visit page): `Jo Park cancelled Thu 1pm. Offer it to Lee Moss (booked Sat 10am)? They'd get: "Hi Lee, it's Northshore Roofing. A spot opened up on Thu Oct 15, 1:00 p.m., earlier than your chimney flashing on Sat Oct 17, 10:00 a.m. Want it? You can switch here: [their booking link]"`. On Y, Lee gets that text; Lee switches on the visit page (nothing moves on its own). Only gaps the visit page can actually take are offered (see Fill the gap below) — with the default 24-hour change cutoff that means gaps 24–48 hours out.
- **The owner by text:** "what's the weather look like for the jobs this week" (`weather_outlook`), "who's working tomorrow" (`crew_plan`), "rain day, move all of tomorrow to Friday" (`move_day` → a `bulk_reschedule` approval; "Reply Y 14 to move them, N 14 to leave them").
- **House orgs (A1 etc.)** get none of this unless the owner switches it on in Settings → AI front desk → Dispatcher.

### Approval kinds

| Kind | Created by | Summary (owner text, ≤ 500 chars) | Y | N / expiry |
| --- | --- | --- | --- | --- |
| `weather_reschedule` | the daily weather check, ONE per company per local day | every job: who, job, old to new time, forecast reason; jobs with no open time ("left as is"); the exact customer text (with `[their booking link]`) | each job re-checked (still at its old time, not cancelled / en route, new time still open) → `rescheduleBooking` → customer text ("moved" texts may go from 07:00; queued until then if it's late). A job whose text couldn't reach the customer before its old start is left as is ("too late to tell them before Thu 6:30am"). Reply: "Moved 2 jobs: Sam Lee to Fri 11am, Jo Park to Fri 9am. Customers texted." | nothing moves ("OK, nothing moved."). Expires an hour before the first job (max 20h) |
| `bulk_reschedule` | owner tool `move_day` (asked inline: `notified_to` = the owner's phone, so "Y 14" counts straight away) | same shape, "Move 2 jobs from Thu Oct 15 to Mon Oct 19? …" | same as above (bulk wording to customers: "We need to move your … from Thu Oct 15 to Mon Oct 19, 9:00 a.m. Sorry for the change.") | nothing. Expires in 12h |
| `fill_gap` | the gap sweep, one per vacated slot | who cancelled / moved off when, who it's offered to (and their current booking), the exact offer text | re-checks the candidate's booking is unchanged and their visit page can still take the gap → offer text (full CASL consent check — it's an offer) | nothing sent. Expires before the gap passes the change cutoff (max 12h) |

If a summary would pass 500 characters, fewer jobs are included ("(3 more not included - ask me again after.)") and Y only moves the jobs shown. A price note ("Y 12 $700") on these kinds is never acted on (`ok:false`, nothing moved). "Y 12 except Smith" isn't supported (it isn't a valid approval reply; the owner channel asks "did you mean…").

### How it works

- **Location.** `companies.latitude / longitude` (+ `location_source`, `location_checked_at`). Geocoded once (`geocode.ts`): Places API (New) place details with field mask `location` for `google_place_id`, else a text search on `business_address`, else the first town of `service_area` + ", Ontario". A miss is retried after 7 days. Jobs use the company's location (local service areas). The HTTP calls sit behind the `Geocoder` seam.
- **Weather.** `weather.ts`: a `WeatherProvider` interface; `openMeteoProvider` calls the forecast API with `hourly=precipitation_probability,precipitation,wind_speed_10m,temperature_2m`, `timezone=GMT&timeformat=unixtime` (job windows are matched by instant — DST-proof). `OPEN_METEO_API_KEY` set → `customer-api.open-meteo.com` + `apikey`; unset → the free `api.open-meteo.com`. One forecast per company per hour (memory, then `dispatch_weather_cache`, shared across workers).
- **At risk** (`assessWindow`, pure): over the hours the job touches (min 1h): rain = max probability ≥ `rain_probability` (60%) **and** total ≥ `rain_mm` (2 mm); wind ≥ `wind_kmh` (50 km/h); temperature ≤ `min_temp_c` (−25) or ≥ `max_temp_c` (35).
- **Which jobs:** `weather.sensitive` = `"all"` | `"none"` | `[service keys]` (matched on `bookings.service_item_id` → `service_catalog_items.service_key`, or the listed service's label in the job title). Default by trade: the industry pack (roofing, landscaping → all; HVAC/plumbing, property maintenance & snow, marine → none), else words in the business name / CrankLeads business type (paving, painting, decks, fencing, exterior / pressure / window cleaning, gutters, siding, masonry … → all; snow, plumbing, HVAC, electrical, interior … → none). Unknown → none (never move jobs on a guess).
- **Weather source** (`environment-canada.ts`, default): Environment Canada's citypage forecasts from the MSC Datamart — free for commercial use under the ECCC Data Server End-use Licence (credit: *Data Source: Environment and Climate Change Canada*, shown in Settings and the weather-check output). The company's location → the nearest of ~800 forecast towns (site list cached a day; none within 150 km → no forecast) → the newest `…_MSC_CitypageWeather_<site>_en.xml` in `today/citypage_weather/<prov>/<UTC hour>/` (that hour, then the 2 before) → hourly points: the next 24 h from the hourly forecast (chance of precipitation, wind/gusts, temperature — no amounts, so **chance of rain alone decides** there), then the day/night periods (06–18 / 18–06 local) with chance, rain accumulation (mm, spread over the period; snow in cm ignored), wind incl. gusts and high/low. Unreadable data gives fewer hours, never invented ones (a window with no hours is never moved). `OPEN_METEO_API_KEY` switches to Open-Meteo's commercial API; the free Open-Meteo API is never used.
- **Weather check** (`weather-sweep.ts`, sweep every 5 min, at most 8 forecast checks per pass — the rest are picked up next pass; `WEATHER_PROVIDER=off` turns it off): from `check_at` (15:00) to 20:00 local, claimed in `dispatch_runs (company, 'weather', local date)` (unique; a failed pass is retried after 30 min). Open jobs (pending/confirmed, nobody en route) in the next 48h that are weather-sensitive and at risk get the first open time (same rules as the owner channel: `scheduling/rules.ts openTimes` over booking windows or hourly online-booking settings, company-wide busy) at least an hour after the job starts, within 14 days, whose own forecast is fine, never a slot already promised to another job in the batch.
- **On our way** (`on-our-way.ts`, every minute): `booking.en_route` activity events from the last 20 minutes. `markEnRoute(ctx, id, { etaMinutes })` now puts the ETA (1–240) on the event; the job-sheet "On my way" button asks for it only when this text will go (`JobSheet.askEta`, from `dispatcherOnOurWayActive`). **No double texts:** if the company has an active `booking.en_route` automation that texts (the `crew-on-the-way` recipe, draft by default), the Dispatcher stays quiet and the recipe texts. One text per booking (`dispatch_messages` key = booking id). Only between 07:00 and 20:00 local (a crew heading out at 06:30 doesn't wake the customer; the event is marked skipped).
- **Crew texts** (`crew-schedule.ts`, every 5 min): crew = `booking_assignments` + task assignees (same as `crew/service.ts`). Tomorrow's list from `crew_texts.time` (18:00) until 21:00; updates for today from 06:00 to 21:00. The first text is keyed `<profile>:<day>`, updates `<profile>:<day>:u<n>`; each stores a fingerprint of the day's non-cancelled jobs (job, time, address, title — done / started / en-route / no-show jobs included with fields that don't change as work happens), so only a meaningful change to a job that hasn't started re-texts; texts list only jobs still to do. The texts already sent for a day are read in one query; only members with jobs or an earlier text that day are looked at. Members with no `phone_e164` are skipped. Sent from the business number (transactional staff texts: no contact, no consent check). "Tomorrow" is the next LOCAL day (`localDayRange`: 23h / 25h across DST).
- **Fill the gap** (`fill-gap.ts`, every 2 min): cancellations (`booking.status_changed` with `metadata_json->>status = cancelled`) and `booking.rescheduled` events from the last 3 hours, filtered server-side to the organizations with the switch on, newest first (200 per type per pass); a move is judged from its event metadata before any booking is read. The vacated slot must start 2–48h from now and the event must really free it (a move to an overlapping time doesn't). **Only what the visit page can take:** the customer switches on their own visit page (`visits/public.ts`), which only shows open times past the change cutoff (`visit_settings.cutoffHours`, default 24; hourly companies also their minimum notice), on its own grid, and only when `allowReschedule` is on — so a gap is offered only when self-serve moves are on, the gap is past that cutoff, the candidate's own visit can still be changed (`visitActions`), and the gap is one of the open times their page would show. Candidate: the soonest booking starting at least an hour after the gap and within 14 days, length within ±max(30 min, 25%) (filtered in the query), a different customer with a textable phone (not opted out), not offered a gap in the last 7 days (sent `gap_offer` rows, or a pending `fill_gap` approval). Claimed per slot in `dispatch_runs (company, 'fill_gap', '<booking>:<start>')`; slots the Dispatcher emptied itself (weather / day moves) are pre-claimed so they're never offered.
- **Sending** (`messages.ts`): every text is a `dispatch_messages` row (unique company + kind + dedupe key) claimed before `deliverMessage` from the company's number. Customer texts wait for `customer_hours` (09:00–20:00 local; "your visit moved" texts from 07:00) — outside them the row is `queued` with `not_before` = the next opening and the `dispatcher:queue` sweep (every minute) claims and sends it (queued → sending, conditional). Before a queued text goes out it is re-checked: the feature is still on (weather moves → weather switch, gap offers → fill gap, crew texts → crew texts; owner-initiated day moves always go), a "moved" text's booking is still open at the announced time, a gap offer's candidate is unchanged and their page can still take the gap — otherwise the row is `skipped` with the reason. "Moved" texts expire at the job's old start. The queue only reads rows of loaded (feature-on, active) companies, so rows of paused companies never block it, and a `sending` row older than 10 minutes (a crashed worker) goes back to the queue. A failed send is retried twice (10 min apart). Crew texts: 06:00–21:00. **Consent:** texts about the customer's own booking (on our way, your visit moved) are transactional — opt-out is always respected, the 6-month implied-consent expiry isn't applied; a gap offer goes through `deliverMessage`'s full consent check (`consentContact`). The STOP footer is automatic. Every customer text names the business, never the platform.

### Owner tools

| Tool | Does |
| --- | --- |
| `weather_outlook` | Next 3 local days: daytime rain chance / mm, wind, temperature, whether it's over the owner's limits, and each open job with `at_risk` (for weather-sensitive jobs). |
| `crew_plan` | A day (default tomorrow) by crew member (with "cell on file"), plus unassigned jobs. |
| `move_day` | `from_date` (today / tomorrow / YYYY-MM-DD) → `to_date`: each open job keeps its time of day if open on the new day, else the next open time that day; jobs that don't fit are listed "left as is". Creates `bulk_reschedule`; the tool returns `tell_owner_exactly` (with the code). |

Prompt notes: the owner agent is told to relay `tell_owner_exactly` word for word and to use `propose_reschedule` for one job; the SMS agent is told customers may reply to these texts, to point them to the booking link in the text (it lets them move), never to say a spot is held, never to move or cancel bookings itself, and to hand off if they're upset.

### Settings

`companies.ai_settings.dispatch`, read only by `staff/dispatcher/settings.ts readDispatchSettings`:

```
dispatch = {
  weather:        { enabled, sensitive: "all" | "none" | [service keys], rain_probability: 60, rain_mm: 2,
                    wind_kmh: 50, min_temp_c: -25, max_temp_c: 35, check_at: "15:00" },
  on_our_way:     { enabled, from: "07:00", until: "20:00" },
  crew_texts:     { enabled, time: "18:00" },        // 06:00–20:59 (crew texts stop at 21:00)
  fill_gap:       { enabled },
  customer_hours: { from: "09:00", until: "20:00" }
}
```

Every `enabled` defaults **on** for CrankLeads orgs and **off** for house orgs. Route: `GET | PATCH /api/organizations/:org/companies/:company/ai-settings/dispatch` (members read; owners/admins PATCH `{ weather?: { enabled, sensitive (null = trade default), rainProbability, rainMm, windKmh, minTempC, maxTempC }, onOurWay?: { enabled }, crewTexts?: { enabled, time }, fillGap?: { enabled } }`, merged into `ai_settings.dispatch` only with the optimistic `updateAiSettings`). UI: `src/components/settings/staff/DispatcherSettingsSection.tsx` — four switches, which jobs weather affects (all / some services / none, or back to the trade default), the limits, the crew text time, how many team members have a cell, and a note when the "On my way" automation is the one texting.

**Crew cells:** `organization_memberships.phone_e164` (E.164, check constraint; service-role writes only). Settings → Members shows each member's cell with **Add / Edit** (`MemberPhoneField`): members edit their own, owners/admins anyone's — except that only an owner can change an owner's number (same rule as roles). Routes: `GET /api/organizations/:org/members/phones` (members), `PUT /api/organizations/:org/members/:profileId/phone { phone: string | null }` (self, or owner/admin — not an owner's number unless you're an owner; 10-digit NANP or +E.164).

### Schema (`20261011120000_staff_dispatcher.sql`)

- `companies`: `latitude`, `longitude`, `location_source`, `location_checked_at` (locked to the service role by the column-grant allowlist).
- `organization_memberships.phone_e164` (+ format check).
- `dispatch_messages` (kind `on_our_way | crew_schedule | crew_update | job_moved | gap_offer`, unique `(company_id, kind, dedupe_key)`, status `queued | sending | sent | skipped | failed | blocked`, `not_before`, `expires_at`, `attempts`, `payload`) — members read, service role writes.
- `dispatch_runs` (kind `weather | fill_gap`, unique `(company_id, kind, run_key)`) — members read, service role writes.
- `dispatch_weather_cache` (one row per company) — service role only.
- No new `activity_events` index: the sweeps filter by `organization_id` + `occurred_at`, which the existing `(organization_id, occurred_at desc)` index serves. A plain CREATE INDEX would lock that big table inside the migration's transaction; if a large database ever needs one, create it by hand with `create index concurrently` (the statement is in the migration's comments).

Table types live in `staff/dispatcher/db-types.ts` until they're merged into `database.types.ts`.

### Env

`GOOGLE_PLACES_API_KEY` (optional: the exact business location from its Google listing; unset → the business's town from Environment Canada's forecast-town list, matched on the address or service area), optional `OPEN_METEO_API_KEY` (only to use Open-Meteo's commercial API instead of Environment Canada), optional `WEATHER_PROVIDER=off`. No AI model calls (everything is rules), so no `AI_MODEL_DISPATCHER`.

### Sweeps

`dispatcher:on-our-way` (1 min), `dispatcher:queue` (1 min), `dispatcher:fill-gap` (2 min), `dispatcher:crew-texts` (5 min), `dispatcher:weather` (5 min) — through `runStaffSweeps`. The companies are loaded once per tick (cached ~1 minute per worker, `loadDispatchCompaniesCached`) and filtered server-side to feature-on companies: every company of a CrankLeads org, plus house-org companies that switched something on (`ai_settings.dispatch.any_on`, written by `mergeDispatchSettings`); reads page past PostgREST's 1000-row cap. The queue sweep looks at the queue first and loads nothing when nothing is due.

`dispatcherActiveFor(admin, { organizationId, companyId })` (`settings.ts`) says whether any Dispatcher feature is on for a company (for showing the role's prompt notes only where relevant).

### Tests

`src/test/staff-dispatcher.test.ts` (fake DB, real services; Twilio, the weather provider and the geocoder faked): settings defaults (CrankLeads on / house off, trade sensitivity), DST day lengths and local hours for America/Toronto, geocoding fallbacks and retry, Open-Meteo parsing / thresholds / endpoint / hourly cache, the weather check end to end through owner-channel `decideApproval` (one per day, Y moves + texts, idempotent re-run, N, re-checks at Y, late Y queues customer texts until 09:00), on-our-way (ETA on the event, one text, no double with the recipe, opt-out, hours, house org), crew texts across the Nov 1 DST change (25h day, 18:00 EST = 23:00Z, updates only on change, no-phone skip), fill the gap (7-day rule, refilled slot, setting off, re-check at Y), owner tools (`move_day` → Y via `decideApproval`, scoping, `crew_plan`, `weather_outlook`), member cells.

### Not yet

- The weather source was never reached from the build sandbox: check it live with `npx tsx src/server/jobs/weather-check.ts "Midland, ON"` (no keys, no database).
- "Y 12 except Smith" (partial approval) isn't supported — the owner says N and moves jobs one by one.
- Multi-location businesses use one location for every job (no per-job geocoding).

## Marketer

The Marketer brings past customers back and keeps the Google listing active. It never sends anything commercial, and never puts anything on Google, without the owner's `Y`. Code: `src/server/services/staff/marketer/`. Migration: `20261011130000_staff_marketer.sql` (rollback in `supabase/rollback/`).

**What the owner sees**

- About once a month (local weekday, 10:00–16:00): *"#12 Win-back text to 42 past customers (last job 9-24 months ago): "Hi [first name], it's Northshore Roofing. Fall is a good time to have the roof looked at before the snow - reply here and we'll book you in. Info: https://northshoreroofing.ca Reply STOP to opt out" Sends Mon-Sat 10am-7pm, up to 30/hour. Reply Y 12 to approve, N 12 to skip."* `Y 12` → *"Approved - texting 42 past customers Mon-Sat 10am-7pm, up to 30/hour. Replies go to your assistant. Text "stop the campaign" any time."*
- A new Google review: *"#13 New 5-star Google review from Sam K (https://maps.google.com/…). Reply: "Thanks so much, Sam…" Y = I text you this reply to paste on Google."* (the review's own words are never copied into texts or approvals — the link opens it). 3 stars or less also gets a heads-up text right away (stars, name, link). `Y 13` → a text with the review's Google link and the reply to paste.
- Monday: *"#14 Google post for this week (seasonal tip): "…" Y = I text it to you to paste on your Google listing."* `Y 14` → the copy + `https://business.google.com/posts`.
- By text: "start a win-back" (`start_win_back`: drafts now; the approval is texted right away, even at night, since the owner asked), "stop the campaign" (`stop_campaign`: cancels at once, queued texts skipped, a pending approval superseded) and "how did the campaign do?" (`marketing_results`). Settings has a **Stop this campaign** button (`POST …/ai-settings/marketing/stop`).
- A note on these ("Y 12 $700") does nothing: the item is re-sent under a new code ("goes out exactly as shown… Reply Y 15 to approve it as written").

**CASL consent** (`workflow-engine/messaging.ts` `checkConsent`): `ConsentContact.last_purchase_at` (optional) is the contact's latest completed booking or paid invoice at the sending company; a purchase gives implied consent for **2 years** from that date. Inquiries stay at 6 months, express consent never expires, an opt-out always wins. Callers that don't pass it (reviews, recipes, the SMS agent) are unchanged. Every campaign text names the business, carries contact info (the website, else the published generated site, else the business phone — no contact info → no campaign is drafted) and ends with "Reply STOP to opt out" (deliverMessage doesn't add a second one).

**Win-back campaigns** (`campaigns.ts`, `audience.ts`)

| Step | What happens |
| --- | --- |
| Audience | Past customers of the company whose latest purchase was `months_min`–`months_max` ago (9–24; max is capped at 24), **one per phone number** (last 10 digits; duplicates → `duplicate_phone`). A number is excluded when ANY contact of the company with it opted out (a STOP only opts out the contact it matched), was texted or queued by a campaign in the last 90 days (from `sent_at`, else `created_at`), has an open booking (pending/confirmed) or open quote (sent/viewed/approved/deposit_paid, last 180 days), or bought more recently than `months_min`; the chosen contact also needs consent (checked with the purchase date). Capped at 4 × the weekly cap. All reads page past PostgREST's 1,000-row cap; counts use `count: exact`. |
| Draft | Only with the company's own texting number (`resolveCompanySmsFrom` — never the platform default, which is another business's line) and contact info; otherwise the monthly sweep texts the owner once that month why. `marketing_campaigns` row (unique `company_id, kind, period_key` → once per month; partial unique index → one active campaign per company; skipped within 21 days of the last campaign; a crashed `draft` older than 1h is cancelled and its rows released) → recipients snapshotted as `queued` → Claude writes the body from the business facts (name, trade, service area, price-list services) + a seasonal hook; code rejects money, `%`, "free", deals, urgency and links and falls back to a plain template → `marketing_campaign` approval (48h). No audience → the row is closed `no_audience`, nothing asked. |
| Y | `awaiting_owner → sending` (conditional on the approval id). |
| N / expiry | `cancelled`; queued recipients `skipped` (they don't count against the 90-day cooldown). |
| Sending | Sweep `marketer_campaign_sender` (every 5 min): only inside the send window (Mon–Sat 10:00–19:00 local by default, always within 09:00–20:00), at most `per_hour` (30) per hour counting sent + in-flight claims, ⌈per_hour / 6⌉ per tick, one batch per campaign per 5-minute slot across workers (`marketing_sweep_claims`), and `weekly_cap` (150) per 7 days. Each recipient is claimed `queued → sending` before its text; right before sending, every contact with the same number is re-checked (opt-out, cooldown, open booking/quote, bought again since the draft) and consent is enforced in deliverMessage. A claim older than 30 min is `failed`, never retried. Sent with `deliverMessage` from the company number, `sent_by = 'marketer'`. |
| Holds | Owner paused all texts (`ai_settings.owner_pause`), company paused/archived, win-back turned off, or no company number → nothing goes out (`held_since`, `hold_reason`; the owner is texted once for a missing number). The hold clears itself when the cause does. Held more than 3 days → cancelled and the owner told ("I cancelled the win-back campaign: it was on hold for 3 days…"), so an old seasonal text never resumes months later. |
| Replies | Come back to the company number; the SMS agent answers them (prompt note: treat it as an enquiry, never invent an offer). |
| Results | `campaignResults`: sent / skipped / failed / to go, replies, bookings and quotes from recipients within 30 days of their text. |

**Google reviews** (`reviews.ts`, `google.ts`): hourly sweep, once a day per company (claimed in `marketing_sweep_claims`, local 09:00–20:00), Places API (New) `GET /v1/places/{id}` with field mask `reviews,rating,userRatingCount,googleMapsUri` (`GOOGLE_PLACES_API_KEY`; ≤ 5 reviews). Refreshes `companies.google_rating` / `google_review_count`. Each new review (unique `company_id, review_name`) published in the last 30 days (and any left at `new` by a crash) gets a Claude reply draft (warm, specific, never argues, no refunds/discounts/private details; fenced as data; fallback template) and a `review_reply` approval (72h). On Y: `postReply` seam (no GBP API yet → returns not posted) → the owner is texted the reply + the review's Google link (claimed with `owner_texted_at`). Google content (text, author, rating, link, publish time) is nulled 30 days after it was fetched, for every company whatever its settings; older reviews on a first fetch are recorded with no content at all. Long-term we keep only the review's resource name (so it's never drafted twice) and our own reply + status.

**Google posts** (`posts.ts`): Monday 09:00–17:00 local (Tuesday catch-up), one `google_post_drafts` row per company per week, rotating service spotlight → seasonal tip → recent-job highlight (job title only, no names/addresses; falls back to a tip). Same copy checks. `google_post` approval (72h); Y texts the owner the copy + the GBP link.

**Settings** — `marketerActiveFor(admin, { organizationId, companyId })` (settings.ts) says whether the Marketer works for a company (any feature on, company active). `companies.ai_settings.marketing = { win_back: { enabled, months_min, months_max, weekly_cap, per_hour, start_hour, end_hour, days }, review_replies: { enabled }, google_posts: { enabled } }`, read only by `staff/marketer/settings.ts` (`readMarketingSettings`). Every feature defaults **on for CrankLeads orgs, off for house orgs** (A1) unless turned on. Route `GET|PATCH /api/organizations/:org/companies/:company/ai-settings/marketing` (members read; owners/admins PATCH `{ winBack: { enabled, monthsMin, monthsMax, weeklyCap }, reviewReplies: { enabled }, googlePosts: { enabled } }`, merging only `marketing`; the send throttle isn't owner-editable). UI: `src/components/settings/staff/MarketerSettingsSection.tsx`.

**Schema** — `marketing_campaigns`, `marketing_campaign_recipients` (unique `campaign_id, contact_id`), `google_reviews`, `google_post_drafts` (members read, service role writes), `marketing_sweep_claims` (service role only). Local types in `staff/marketer/db-types.ts`.

**Env** — `AI_MODEL_MARKETER` (default `claude-sonnet-5-5`), `GOOGLE_PLACES_API_KEY` (already set for done-for-you), `ANTHROPIC_API_KEY` (without it every draft uses the plain templates).

**Not yet** — no Google Business Profile API: replies and posts are pasted by the owner (`postReply` is the seam). The Places API only returns 5 "most relevant" reviews and doesn't say whether the owner already replied, so a recent review the owner answered on Google may still get a draft (they can N it). Seasonal / custom campaign kinds exist in the schema but only win-back is drafted. The campaign send window and rate aren't editable in the UI.

Tests: `src/test/marketer.test.ts`, `marketer-consent.test.ts`, `marketer-route.test.ts`.

## Office manager

## Customer import

A new business brings its existing customer list, so the Bookkeeper, Marketer and Dispatcher have history on day one. Code: `src/server/services/staff/importer/`. Migration: `20261012110000_staff_importer.sql` (rollback in `supabase/rollback/`). Settings: Settings → AI front desk → **Customer import** (`src/components/settings/staff/ImporterSettingsSection.tsx`). Pages: **Import customers** (`/import`, signed in, owners/admins; `src/screens/ImportCustomersPage.tsx`) and the texted link `/import/:token` (no login; `src/screens/PublicImportPage.tsx`). Both use `src/components/import/ImportWizard.tsx`.

**What the owner sees.** Dana texts "can I bring my customers over from Jobber?" → "Sent you the link." and a separate text: "CrankLeads: Bring your customer list over: upload a spreadsheet (CSV or Excel) from Jobber, QuickBooks, Housecall Pro, Square or your own. You'll see a preview before anything is saved, and nobody gets texted. https://…/import/…". She uploads `clients.csv`; a few seconds later the page shows her columns with our guess for each (she can change any of them) and a preview: "272 new customers · 40 you already have (blanks filled) · 1,104 past jobs · 14 open balances · $8,420", 9 rows that will be skipped and why, and sample rows. She presses **Import 312 customers**; she can close the page. When it's done: "CrankLeads: Imported 312 customers (272 new, 40 you already had - blanks filled, nothing overwritten), 1,104 past jobs, 14 open balances ($8,420) from clients.csv. 9 rows skipped - see the import page. Nobody was texted or emailed.\n#12 14 imported balances, $8,420 owing (oldest from Mar 3, 2026). Nobody has been reminded yet. Y to let the Bookkeeper start reminders on them (texts and emails, your usual schedule). Reply Y 12 to approve, N 12 to skip."

### Upload (`batches.ts`, `deps.ts`, `links.ts`)

- CSV or XLSX, ≤ 10 MB, ≤ 25,000 rows, ≤ 60 columns. The browser asks for a batch (`POST …/imports` or `POST /api/public/import/:token`), gets a one-time signed upload URL for the private bucket **`customer-imports`** (path `{org}/{batch}.csv|xlsx`, no storage policies; same pattern as receipts) and uploads straight to storage, then says `uploaded`. ≤ 20 uploads per company per day.
- **The link** (`/import/:token`): one row per company in `import_links` (service role only), a 32-character random token, valid 14 days after it was last sent (an expired one gets a new token when it's sent again). Same pattern as the setup link: the token is the credential, one 404 for every miss, rate-limited per token and IP, and the link only works while the import is on for that company. Sent by the owner tool `send_import_link`, the "Text me the link" buttons (page + Settings), and the concierge action **Send import link**.
- The dashboard's setup card (CrankLeads, until live) lists **Bring your customer list** as an optional extra (`dfy/progress-view.ts`), ticked once an import is done.

### Reading the file (`parse.ts`)

CSV: our own RFC 4180 reader (quotes, `""`, newlines inside quotes, comma / semicolon / tab, UTF-8 BOM, Windows-1252 fallback). XLSX: **`exceljs` 4.4.0** (pinned; the sheet with the most rows; date cells → YYYY-MM-DD; rich text, formulas and hyperlinks → their text). The first non-empty row is the header; empty rows are dropped; each row keeps its spreadsheet row number (`row_index + 2`), which is what the preview and the owner text call "row 10". Exact duplicate rows are dropped (unique row hash per batch).

### Columns (`mapping.ts`)

Fields: full / first / last name, business name, phone (several columns allowed; the first good number is the main one, the rest go to `metadata.other_phones`), email, address (parts joined in column order; billing address steps aside when there's a service address), notes, tags, last service date, job date / description / amount, balance owing, invoice date, due date, invoice number. Header heuristics cover Jobber, QuickBooks, Housecall Pro, Square and plain spreadsheets (ids, lifetime totals, lead sources, created dates and statuses are ignored). When they're unsure (no name column, no phone/email column, or a generic header like "Date" / "Total" / "Title"), **Claude** (`AI_MODEL_IMPORTER`, default `claude-sonnet-5-5`, usage recorded) gets the headers and ≤ 5 sample rows fenced as `<data>` (the system prompt says the content is data, never instructions) and answers one field per column; only the unsure columns take its answer, and a malformed answer is ignored. The owner can change any column; every edit rebuilds the preview. A mapping needs at least a name, phone or email column.

### Rows (`normalize.ts`, `resolver.ts`)

Phones → E.164 (North American numbers; "+…" kept; extensions dropped), emails lowercased, names split ("Lee, Jamie", titles dropped, ALL CAPS → Title Case), money → cents ("$1,240.50", "(45.00)"), dates in each column's own order (a column with a first part > 12 is day-first; otherwise month-first; also "Jun 14, 2025" and Excel serial numbers). A row with no name, business, phone or email is skipped with the reason. A job date today or later, a credit balance, a phone or date we can't read are warnings (the row still imports). A row's past job is its job date, else its last service date.

**Matching** an existing contact: same phone (last 10 digits) or same email, in that company; a row with neither matches only a contact with the same name that also has neither. Rows of one file that are the same customer become one contact (their jobs all count).

### Preview (`preview.ts`)

Before anything is written: new contacts, matches to existing contacts, repeat rows, skipped rows with reasons (≤ 100 listed), past jobs, open balances and their total, new customer accounts, 8 sample rows. A re-upload shows what's already in ("+3 already in") and "You imported this same file on Oct 3" (same file hash).

### What the import writes (`apply.ts`)

The sweep `importer:batches` (every tick; a lease per batch, 2 minutes) imports **500 rows per chunk** with a ~25 s budget per pass, never in the HTTP request (a small file — ≤ 1 MB — is read and previewed inside the upload request so the page is quick). Each row records what it did on `import_rows` before the cursor moves, so a pass that dies mid-chunk resumes without doing a row twice.

| | Written as | Never |
| --- | --- | --- |
| New customer | `contacts`: `consent_source: "import"`, **no `sms_consent_at`**, `stage: "closed"`, `metadata.import = { batchId, at, file }`, address / tags / other phones in `metadata` and a notes line | consent, express or implied, from the import |
| Existing customer | **blanks only**: last name, phone, email, notes, account, `metadata.address/tags` | overwriting anything; touching consent, opt-outs or stage |
| Business name | `customer_accounts` (when there's none by that exact name), linked to the contact | — |
| Past job | `bookings` status **completed** in the past (noon local on the job date, `completed_at` = that date → the Marketer's CASL purchase date), `price_cents`, `source: "import:<batch>"`, `source_call_id: "import:<key>"` (unique per company) | `createBooking`, events, recipes, review requests, crew notices |
| Balance owing | `invoices` status **sent**, the balance as one "Balance carried over" line, no tax, `issue_date` from the file (else today), due date from the file (else the issue date), a fresh invoice number, `imported_at`, `import_batch_id`, `import_key` (unique per company), **`import_hold: true` + `reminders_paused: true`** | emailed, texted, `invoice.sent`, or pushed to QuickBooks / Xero |

**No customer messages, no workflows.** Every write is a direct insert/update with the service role, pinned to the batch's organization and company; nothing calls a service that emits an activity / workflow event or sends anything (tested: no SMS but the owner's, no email, no dispatch, no `activity_events`, no `workflow_event_jobs`, no `message_log` row for a customer). Imported balances are also kept out of the **accounting sync** (the trigger functions skip invoices with `imported_at`, and payments on them): they came from the owner's books, so pushing them back would duplicate them.

**Idempotent re-upload.** The same file again finds the same customers (matched, blanks only), the same jobs (`source_call_id`) and the same balances (`import_key`: contact + their invoice number, else contact + date + amount), so it creates nothing new. A balance changed since (no invoice number in the file) is a new balance.

When the batch is done, one text to the owner (from the platform number, outside 21:00–08:00 — it waits for the morning), with the `chase_imported_balances` question in the same text when balances came in.

### Imported balances stay on hold (`hold.ts`, `approvals.ts`)

While `invoices.import_hold` is true: no reminder email and no `invoice.overdue` automation (one tolerant check in `invoices/reminders.ts`, only for paused invoices), and no Bookkeeper text (it skips `reminders_paused` invoices).

| Kind | Asked by | Owner sees | Y | N / expiry |
| --- | --- | --- | --- | --- |
| `chase_imported_balances` (TTL 7 days) | the import's done text; `import_status` with `start_reminders`; the Settings / page button | `14 imported balances, $8,420 owing (oldest from Mar 3, 2026). Nobody has been reminded yet. Y to let the Bookkeeper start reminders on them (texts and emails, your usual schedule).` — the last sentence follows the business's settings (texts only, emails only, or "your reminders are off, so nothing goes out until you turn them on") | `import_hold` and `reminders_paused` cleared on that batch's balances still on hold (conditional, so a retry releases nothing twice): "Done - reminders can start on 14 imported balances ($8,420), on your usual schedule." | "OK - the 14 imported balances ($8,420) stay on hold: no reminders. Text "import status" any time to start them." |

A note ("Y 12 only Jones") can't change anything here: nothing is released and the same question comes back under a fresh code.

### Undo (`undo.ts`)

From the import page (a done batch, or a failed one that started importing): the sweep removes, phase by phase in chunks, what the batch **created**, unless it was used since — balances with a payment, reminder or view; jobs edited, reassigned, invoiced or no longer completed; customers with any message, conversation, booking, quote or invoice left, or edited; customer accounts still in use. Kept records are reported ("Kept 1 customers … that were used since") with up to 10 examples. Customers the import only matched are never removed (blanks it filled stay filled). A pending `chase_imported_balances` question is withdrawn.

### Owner tools (`owner-tools.ts`)

- `send_import_link`: texts the owner the link.
- `import_status`: the last 3 imports (status, new / matched customers, past jobs, balances, rows skipped, undo summary), balances on hold and any pending question. `start_reminders: true` creates the `chase_imported_balances` approval inline ("#12 … Reply Y 12 to approve, N 12 to skip.") or points at the pending one.

### Settings, routes

`companies.ai_settings.import = { enabled? }` — **on** for CrankLeads orgs, **off** for house orgs (A1 sees no tools or notes, can't upload, and the sweep leaves any batch of a company that has it off alone until it started importing). Routes (owners/admins; the overview is readable by members):

- `GET|PATCH …/companies/:company/ai-settings/import`
- `GET|POST …/companies/:company/imports`, `GET|POST …/imports/:batch` (`uploaded`, `mapping`, `import`, `undo`, `cancel`), `POST …/imports/send-link`, `POST …/imports/start-reminders`
- `GET|POST /api/public/import/:token`, `GET|POST /api/public/import/:token/:batch` (same actions; the token's company only)

### Data (migration `20261012110000_staff_importer.sql`)

- `import_links` (service role only), `import_batches` (members read; statuses uploading → uploaded → mapped → previewed → importing → done, failed, undoing → undone, cancelled), `import_rows` (service role only; unique `(batch_id, row_hash)`; what each row created).
- `invoices.imported_at / import_batch_id / import_hold / import_key` (no client grants), unique `(company_id, import_key)`; unique `(company_id, source_call_id)` for `bookings` with an `import:` key; an index on `contacts.metadata->import->>batchId`.
- Bucket `customer-imports` (private, 10 MB, CSV / XLSX types).
- `accounting_enqueue_invoice` / `accounting_enqueue_payment` skip imported balances (the rollback restores the originals).

30 days after a batch is finished the sweep deletes its file and the raw rows' cells (the records it made stay; undo still works). Local row types: `staff/importer/db-types.ts`.

Env: `AI_MODEL_IMPORTER` (optional, default `claude-sonnet-5-5`). Dependency: `exceljs` 4.4.0 (exact).

Tests: `src/test/staff-importer.test.ts` (CSV/XLSX reading, the export heuristics and the Claude fallback, row cleaning, settings + house orgs, preview, the quiet import with consent fields and fill-blanks matching, the no-messages guarantee, quiet hours, idempotent re-upload, chunk resume, leases, the holds against the email and Bookkeeper sweeps, `chase_imported_balances` through `decideApproval` (Y, note, N), undo, owner tools, the token route).

**Not yet:** daily-alert "now 30/60+ days overdue" lines include imported balances the first morning after an import (owner-only; the Bookkeeper's alert file wasn't changed). Imported past jobs dated this week / month count in the weekly report and monthly scorecard job totals. Matching a business account is by exact name. XLS (old Excel) files must be saved as XLSX or CSV first.

## Keep your number

## Hiring & payroll
