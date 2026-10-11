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

One text to the owner each morning: today's jobs, weather risk, money, what's waiting on them and how yesterday went. On briefing days it also carries the Bookkeeper's 8am money alert, so the owner gets one text, not two. Code: `src/server/services/staff/office-manager/`. Migration: `20261012100000_staff_office_manager.sql` (rollback in `supabase/rollback/`). Settings: Settings → AI front desk → **Office manager** (`src/components/settings/staff/OfficeManagerSettingsSection.tsx`).

### What the owner sees

At 07:00 (Tuesday), from the platform number to the verified owner cell:

```
CrankLeads: Morning Dana - Northshore Roofing, Tue Oct 13.
Today: 4 jobs, first at 8am. Mike 2, Sam 1, 1 unassigned.
Weather: today rain 90%, 12 mm - 4 jobs at risk.
Money: $1,250 came in yesterday, $2,480 overdue (2 invoices).
Payment failed: Jamie Lee $500 (INV-30).
Now 30+ days overdue: Jamie Lee $1,240 (INV-30).
Waiting on you: #12 AI estimate for Jamie Lee: Eavestrough repair $750 +...; #13 Record $500 e-Transfer from Bob Jones on INV-9.
Yesterday: 2 new leads, 2 quotes sent, 1 approved. AI handled 2 text chats and 1 call.
Reply "today" for details.
```

Dana texts "today" → the owner agent calls `briefing_now` with `detail: true` and relays every job by crew member, the weather numbers, who's late paying and each approval in full. On a truly quiet day: `Morning Dana - all quiet at Northshore Roofing today (Tue Oct 13): no jobs booked and nothing waiting on you.`

### The parts (`gather.ts`, `compose.ts`)

Each part is read on its own. A part with nothing to say is left out. A failed read of the weather, money or yesterday parts just leaves that part out (logged). A failed read of **today's jobs, the approvals waiting, or the Bookkeeper's alert items** (when that alert is on) fails the attempt instead (`last_error "couldn't read: jobs"`), so it is retried. On the last try before 11:00 the text goes anyway, but it says "Today's jobs: couldn't load them - check the app." / "Approvals: couldn't load them - text \"waiting\"." and is never the quiet one-liner.

| Part | Source |
| --- | --- |
| Today | The Dispatcher's `crewPlanForDay` for the local day (pending / confirmed / completed / no-show; cancelled excluded): count, first start, per crew member (first names, busiest first) plus unassigned. |
| Weather | Only when the Dispatcher's weather check is on for the company (`dispatch.weather.enabled`, and `WEATHER_PROVIDER` isn't `off`) and its location is already stored (the Dispatcher geocodes; the briefing never does). `getCompanyForecast` (the shared hourly cache) + `assessWindow` with the owner's limits: today's and tomorrow's daytime (07:00–19:00 local; today from now) and each weather-sensitive open job's own window. Nothing is fetched otherwise. |
| Money | Collected since the last briefing day (succeeded invoice payments + quote deposits), and the overdue total and count (`ar.ts` `loadOpenInvoicesWithNames` + `agingSummary`). Imported balances still on hold (`invoices.import_hold`, read tolerantly) are left out of the overdue total. |
| Money alert | The Bookkeeper's 8am items not told yet (see below), one line per kind, exactly as the alert words them. |
| Waiting on you | `listPendingApprovals` (codes assigned first, as `waiting_on_me` does), minus expired ones and owner-command confirmations: up to 3 one-liners, then "+N more". |
| Yesterday | New leads (contacts created, not imported ones (`consent_source 'import'`) or job applicants (`consent_source 'job_application'` or `metadata.kind 'applicant'`)), quotes sent / approved, customers the AI texted with (`message_log.sent_by 'sms_agent'`, one per contact) and calls it answered (inbound, not voicemail, 5 s or more — the weekly report's rule). |

"Yesterday" is everything since the previous briefing day, local midnight to midnight: Monday after a Saturday briefing says "Since Saturday" and covers Saturday and Sunday (49 hours across the November DST change).

**Length.** At most 4 SMS segments: 612 GSM-7 characters including the "CrankLeads: " prefix (extension characters count double). The text is flattened to plain ASCII (accents, curly quotes, dashes, emoji), so it is never sent as UCS-2. When it's too long, in order: approval one-liners are shortened, then cut to one, the Yesterday line goes, the crew breakdown goes, tomorrow's weather goes, the approvals become a count, and last the folded money lines are dropped from the end. Money lines that didn't fit are not marked reported, so they come the next morning.

### Once a day (`briefing.ts`)

Sweep `office-manager:briefing`, every 2 minutes. Companies are loaded the Bookkeeper's way (every company of a CrankLeads org, plus house-org companies with `ai_settings.office_manager.enabled = true`, filtered at the query; paused / archived companies skipped). A company is due from its set time until 11:00 local, on its briefing days, with a verified owner cell. Today's rows for the due companies are read in one query per 200 companies, so a company already done costs nothing per pass.

- **Claim, then send.** `owner_briefings` is unique on `(company_id, local_date)`. The row is inserted before anything is read or sent, so two workers send one text (tested with two concurrent passes).
- **A failed send** marks the row `failed`, which releases it: a later pass re-claims it (conditional update on `status = 'failed'` and the attempt count — one winner) 10 minutes later, up to 3 tries, and only before 11:00. A read error after the claim (or an unreadable jobs / approvals / money-alert part, see above) also releases it.
- **A STOP to the platform number** makes the row `skipped` (no retries that day). A worker that dies mid-send leaves the row `claimed`, and it isn't retried: one missed briefing beats a double text.
- `briefing_now` never touches `owner_briefings` and never marks money items.
- `money_fold` records whether the alert's items rode along (`included`), the alert was off (`none`), or they couldn't be read (`failed`). It stays `included` even if marking them reported fails afterwards, since the text carried them.

### The Bookkeeper's 8am alert

- `staff/bookkeeper/daily-alert.ts` (minimal edit): `runDailyMoneyAlerts` skips a company when `briefingTakesMoneyAlert` (`office-manager/settings.ts`) is true. That means the briefing is on, today (local) is a briefing day, the company is active and the owner cell is verified, and today's `owner_briefings` row hasn't ended without the items. A row that is `sent` with `money_fold 'failed'` (the items couldn't be read on the last try), `skipped`, or `failed` with every try used lets the alert go alone. No row, `claimed`, `failed` with tries left, or `sent` with `money_fold 'included'` defers. The settings are checked first (one company read, using the alert's own CrankLeads flag), and the row only on a briefing day. Because the briefing marks items only after a send that carried them, and a final row never folds again, the two never report the same items.
- On other days (Sunday by default), or with the briefing off, the alert goes alone as before.
- The briefing reads the untold items with the alert's own `collectAlertEntries` + `newEntries`, words them with `moneyAlertLineGroups` (also used by `composeMoneyAlert`), and only after its text went out calls `markMoneyAlertReported`. That records the keys in `money_alert_items`, marks told promises `missed`, and writes the day's `money_alerts` row (`sent`, or `skipped` when there was nothing).
- A failed briefing leaves the items untold for the retry or the next day.
- Items that turn up after the briefing went out (e.g. a payment that fails at 9am) come the next morning.
- `owner_briefings.money_items` lists what each briefing carried.

### Email copy

With `channels: ["sms", "email"]` the owner also gets an email (`deliverMessage`, Resend) right after the text, to `resolveOwnerContacts` without the platform fallback (`companies.owner_email`, else the org owner / admin). It holds the same summary plus every job by crew member, the weather numbers, who's late paying and each approval in full.
- Sender name: "CrankLeads" for CrankLeads orgs, the business name otherwise.
- The outcome is stored in `owner_briefings.email_status`.
- The email is only ever a copy: it isn't retried, and it never holds up the text.

### Owner tool `briefing_now`

It returns today's briefing as it would read now (`briefing`), the schedule, and with `detail: true` the full lists (`details`). It is read-only.

Prompt note: when the owner texts "today", "details", "briefing" or "what's on today", call it with `detail: true` and relay it. It is a preview, never a re-send; the owner approves listed items with Y/N and the number.

### Settings

`companies.ai_settings.office_manager = { enabled?, time?, days?, channels? }`, read only by `settings.ts readOfficeManagerSettings`:

- `enabled`: default **on** for CrankLeads orgs, **off** for house orgs (A1 is unchanged unless switched on).
- `time`: `"HH:MM"` from 06:00 to 09:00, default 07:00.
- `days`: local weekdays, 0 = Sunday, default Monday–Saturday.
- `channels`: default `["sms"]`.

Route: `GET|PATCH /api/organizations/:org/companies/:company/ai-settings/office-manager`.
- Members can read: the settings, `defaultEnabled`, whether an owner cell and an email are on file, whether the 8am alert is folded in, and the last briefing.
- Owners and admins can PATCH `{ enabled?, time?, days?, emailCopy? }` (strict schema; the time must be 06:00–09:00; at least one day). It merges only `office_manager` via `updateAiSettings`.

UI: on/off, send time (06:00–09:00 in half hours), day buttons Mon–Sun, "Also email me a copy", the last briefing's text, and a note when the 8am alert rides along.

`officeManagerActiveFor` is true when the briefing is on and the company is active. The registry uses it to offer `briefing_now` and its prompt note only there.

### Schema (`20261012100000_staff_office_manager.sql`)

`owner_briefings` holds one row per company per local date:
- `status`: `claimed | sent | failed | skipped`;
- `attempts` and `last_attempt_at`;
- `body`, `email_status`, `money_items`, `sent_at`, `last_error`.

It is unique on `(company_id, local_date)`, with a composite FK to `companies (id, organization_id)`. RLS lets members read; there are no client writes, and only the service role writes. Re-runnable. The local type is in `staff/office-manager/db-types.ts`.

### Env

None of its own. No model calls: every line is built in code. Weather uses the Dispatcher's provider (Environment Canada, or `OPEN_METEO_API_KEY`; `WEATHER_PROVIDER=off` turns it off). Texts use `TWILIO_FROM_NUMBER` (the platform number); email uses the existing Resend setup.

### Tests

`src/test/staff-office-manager.test.ts` covers:
- settings defaults, bounds and merge;
- DST for America/Toronto: 07:00 is 11:00Z / 12:00Z across the Nov 1 fall-back and the Mar 8 spring-forward, the fall-back Sunday itself, and Monday's 49-hour "Since Saturday" counting a lead from 23:30 Sunday EST;
- the composer: quiet day, parts left out, the 612-character cap with every part overflowing, GSM flattening;
- the sweep: the exact text, two concurrent workers, Sunday as a setting, retry after a failed send (10 min, 3 tries, never after 11:00), platform STOP, no verified cell, house org off / opted in, paused company;
- the fold-in: carried, marked, the 8am alert silent, nothing repeated, kept on a failed send; and no fold when the alert is off;
- weather: on, off, no location — never fetched when off;
- the email copy, `briefing_now` (read-only, details, an approval decided through `decideApproval` drops off), the registry, and the route.

`src/test/staff-bookkeeper.test.ts` adds the deferral test (no 8am text on a briefing day, the alert alone on Sunday). Its fixture turns the briefing off so the standalone-alert tests keep testing the standalone alert.

### Not yet

- No approval kinds: the briefing only reports.
- Items that turn up between the briefing and 11:00 wait for the next morning; they don't get a separate 8am text.
- The weather line needs the Dispatcher to have located the business once (its first 15:00 check).
- "Yesterday" counts text chats by customers the AI texted, not the customers' own messages.

## Customer import

A new business brings its existing customer list, so the Bookkeeper, Marketer and Dispatcher have history on day one. Code: `src/server/services/staff/importer/`. Migration: `20261012110000_staff_importer.sql` (rollback in `supabase/rollback/`). Settings: Settings → AI front desk → **Customer import** (`src/components/settings/staff/ImporterSettingsSection.tsx`). Pages: **Import customers** (`/import`, signed in, owners/admins; `src/screens/ImportCustomersPage.tsx`) and the texted link `/import/:token` (no login; `src/screens/PublicImportPage.tsx`). Both use `src/components/import/ImportWizard.tsx`.

**What the owner sees.** Dana texts "can I bring my customers over from Jobber?" → "Sent you the link." and a separate text: "CrankLeads: Bring your customer list over: upload a spreadsheet (CSV or Excel) from Jobber, QuickBooks, Housecall Pro, Square or your own. You'll see a preview before anything is saved, and nobody gets texted. https://…/import/…". She uploads `clients.csv`; a few seconds later the page shows her columns with our guess for each (she can change any of them) and a preview: "272 new customers · 40 you already have (blanks filled) · 1,104 past jobs · 14 open balances · $8,420", 9 rows that will be skipped and why, and sample rows. She presses **Import 312 customers**; she can close the page. When it's done: "CrankLeads: Imported 312 customers (272 new, 40 you already had - blanks filled, nothing overwritten), 1,104 past jobs, 14 open balances ($8,420) from clients.csv. 9 rows skipped - see the import page. Nobody was texted or emailed.\n#12 14 imported balances, $8,420 owing (oldest from Mar 3, 2026). Nobody has been reminded yet. Y to let the Bookkeeper start reminders on them (texts and emails, your usual schedule). Reply Y 12 to approve, N 12 to skip."

### Upload (`batches.ts`, `deps.ts`, `links.ts`)

- CSV or XLSX, ≤ 10 MB, ≤ 25,000 rows, ≤ 60 columns. The browser asks for a batch (`POST …/imports` or `POST /api/public/import/:token`), gets a one-time signed upload URL for the private bucket **`customer-imports`** (path `{org}/{batch}.csv|xlsx`, no storage policies; same pattern as receipts) and uploads straight to storage, then says `uploaded`. ≤ 20 uploads per company per day.
- **The link** (`/import/:token`): one row per company in `import_links` (service role only), a 32-character random token, valid 14 days after it was last sent (an expired one gets a new token when it's sent again). Same pattern as the setup link: the token is the credential, one 404 for every miss, rate-limited per token and IP, and the link only works while the import is on for that company. Sent by the owner tool `send_import_link`, the "Text me the link" buttons (page + Settings), and the concierge action **Send import link**.
- The dashboard's setup card (CrankLeads, until live) lists **Bring your customer list** as an optional extra (`dfy/progress-view.ts`), ticked once an import is done.

### Reading the file (`parse.ts`)

CSV: our own RFC 4180 reader (quotes, `""`, newlines inside quotes, comma / semicolon / tab, UTF-8 BOM, Windows-1252 fallback). XLSX: **`exceljs` 4.4.0** (pinned), **streamed** (`WorkbookReader`) and stopped past 25,000 rows — a whole-workbook load of a 10 MB, 240k-row file takes ~900 MB, so it's never loaded whole; the shared-strings part (kept in memory) is size-checked from the zip directory first (≤ 32 MB). The sheet with the most rows wins; date cells → YYYY-MM-DD; rich text, formulas and hyperlinks → their text. The first non-empty row is the header; empty rows are dropped; each row keeps its spreadsheet row number (`row_index + 2`), which is what the preview and the owner text call "row 10". Exact duplicate rows are dropped (unique row hash per batch).

### Columns (`mapping.ts`)

Fields: full / first / last name, business name, phone (several columns allowed; the first good number is the main one, the rest go to `metadata.other_phones`), email, address (parts joined in column order; billing address steps aside when there's a service address), notes, tags, last service date, job date / description / amount, balance owing, invoice date, due date, invoice number. Header heuristics cover Jobber, QuickBooks, Housecall Pro, Square and plain spreadsheets (ids, lifetime totals, lead sources, created dates and statuses are ignored). When they're unsure (no name column, no phone/email column, or a generic header like "Date" / "Total" / "Title"), **Claude** (`AI_MODEL_IMPORTER`, default `claude-sonnet-5-5`, usage recorded) gets the headers and ≤ 5 sample rows fenced as `<data>` (the system prompt says the content is data, never instructions) and answers one field per column; only the unsure columns take its answer, and a malformed answer is ignored. The owner can change any column; every edit rebuilds the preview. A mapping needs at least a name, phone or email column.

### Rows (`normalize.ts`, `resolver.ts`)

Phones → E.164 (North American numbers; "+…" kept; extensions dropped), emails lowercased, names split ("Lee, Jamie", titles dropped, ALL CAPS → Title Case), money → cents ("$1,240.50", "(45.00)"), dates in each column's own order (a column with a first part > 12 is day-first; otherwise month-first; also "Jun 14, 2025" and Excel serial numbers). A row with no name, business, phone or email is skipped with the reason. A job date today or later, a credit balance, a phone or date we can't read are warnings (the row still imports). A row's past job is its job date, else its last service date.

**Matching** an existing contact: same phone (last 10 digits) or same email, in that company, **and a name that fits** (missing parts don't disagree; "Pat" fits "Patricia"). When the phone/email belongs to someone with a clearly different name (a shared family line, a typo), the row is **not** merged: it becomes its own contact (with that phone/email too) and the preview lists it ("same phone or email as Jamie Lee but a different name - added as a separate customer"). A row with no phone and no email is never matched by name — two John Smiths stay two; it only matches the contact an earlier upload made from the very same row (`metadata.import.rowKey`), so a re-upload still adds nobody. Rows of one file that are the same person become one contact (their jobs all count).

### Preview (`preview.ts`)

Before anything is written: new contacts, matches to existing contacts, repeat rows, skipped rows with reasons (≤ 100 listed), past jobs, open balances and their total, new customer accounts, 8 sample rows. A re-upload shows what's already in ("+3 already in") and "You imported this same file on Oct 3" (same file hash).

### What the import writes (`apply.ts`)

The sweep `importer:batches` (every tick; a lease per batch, 2 minutes; every save is conditional on the lease AND the status the step started from, so an owner's Cancel / Undo is never overwritten; companies with the import off are passed over when picking work, so they can't crowd out others) imports **500 rows per chunk** with a ~25 s budget per pass, never in the HTTP request (a small file — ≤ 1 MB — is read and previewed inside the upload request so the page is quick). Each row records what it did on `import_rows` before the cursor moves, so a pass that dies mid-chunk resumes without doing a row twice. Every pass is **counted before it runs** (`import_batches.failures`, reset when the step finishes), so a file that takes the worker down still uses up its tries: reading/previewing gives up after 3 ("We couldn't read that file…"), importing / undoing after 10 — the batch goes to `failed` and the owner is texted ("Your customer import of clients.csv stopped after 4,500 of 12,000 rows … Open the import page to undo what got in, or try the file again."); undo stays available.

| | Written as | Never |
| --- | --- | --- |
| New customer | `contacts`: `consent_source: "import"`, **no `sms_consent_at`**, `stage: "closed"`, `metadata.import = { batchId, at, file }`, address / tags / other phones in `metadata` and a notes line | consent, express or implied, from the import |
| Existing customer | **blanks only**: last name, phone, email, notes, account, `metadata.address/tags` | overwriting anything; touching consent, opt-outs or stage |
| Business name | `customer_accounts` (when there's none by that exact name), linked to the contact | — |
| Past job | `bookings` status **completed** in the past (noon local on the job date, `completed_at` = that date → the Marketer's CASL purchase date), `price_cents`, `source: "import:<batch>"`, `source_call_id: "import:<key>"` (unique per company) | `createBooking`, events, recipes, review requests, crew notices |
| Balance owing | `invoices` status **sent**, the balance as one "Balance carried over" line, no tax, `issue_date` from the file (else today), due date from the file (else the issue date), a fresh invoice number, `imported_at`, `import_batch_id`, `import_key` (unique per company), **`import_hold: true` + `reminders_paused: true`** | emailed, texted, `invoice.sent`, or pushed to QuickBooks / Xero |

**No customer messages, no workflows.** Every write is a direct insert/update with the service role, pinned to the batch's organization and company; nothing calls a service that emits an activity / workflow event or sends anything (tested: no SMS but the owner's, no email, no dispatch, no `activity_events`, no `workflow_event_jobs`, no `message_log` row for a customer). Imported balances are also kept out of the **accounting sync** — the triggers skip invoices with `imported_at` (and payments on them), "Sync now" / settings-save backfill (`accounting/connections.ts queueBackfill`) leaves them out, and the engine (`syncInvoice`, so `syncPayment` too) skips them: they came from the owner's books, so pushing them back would duplicate them.

**Reports.** Imported contacts (and the Recruiter's applicants: `consent_source` `import` / `job_application`) aren't new leads, and imported past jobs (`source_call_id` `import:…`) aren't jobs done in the period — in the monthly scorecard (and so the weekly report, which reuses its inputs) and the Reports overview (`reports/exclusions.ts`). A1's own cutover import uses `a1:…` keys, so its numbers are unchanged.

**Idempotent re-upload.** The same file again finds the same customers (matched, blanks only), the same jobs (`source_call_id`) and the same balances (`import_key`: contact + their invoice number, else contact + date + amount), so it creates nothing new. A balance changed since (no invoice number in the file) is a new balance.

When the batch is done, one text to the owner (from the platform number, outside 21:00–08:00 — it waits for the morning), with the `chase_imported_balances` question in the same text when balances came in.

### Imported balances stay on hold (`hold.ts`, `approvals.ts`)

While `invoices.import_hold` is true: no reminder email and no `invoice.overdue` automation — the email sweep's query leaves held rows out (`import_hold is false or null`), whether or not someone un-paused the invoice by hand, so held rows never use up its 1,000-row limit for other businesses — and no Bookkeeper text (it skips `reminders_paused` invoices) and no morning-alert overdue line.

| Kind | Asked by | Owner sees | Y | N / expiry |
| --- | --- | --- | --- | --- |
| `chase_imported_balances` (TTL 7 days) | the import's done text; `import_status` with `start_reminders`; the Settings / page button | `14 imported balances, $8,420 owing (oldest from Mar 3, 2026). Nobody has been reminded yet. Y to let the Bookkeeper start reminders on them (texts and emails, your usual schedule).` — the last sentence follows the business's settings (texts only, emails only, or "your reminders are off, so nothing goes out until you turn them on") | `import_hold` and `reminders_paused` cleared on that batch's balances still on hold (conditional, so a retry releases nothing twice): "Done - reminders can start on 14 imported balances ($8,420), on your usual schedule." | "OK - the 14 imported balances ($8,420) stay on hold: no reminders. Text "import status" any time to start them." |

A note ("Y 12 only Jones") can't change anything here: nothing is released and the same question comes back under a fresh code.

### Undo (`undo.ts`)

From the import page (a done batch, or a failed one that started importing): the sweep removes, phase by phase in chunks, what the batch **created**, unless it was used since — balances with a payment, reminder or view, or edited since (note: releasing the hold with Y also counts as a change); jobs edited, reassigned, invoiced or no longer completed; customers with any message, conversation, booking, quote or invoice left, or edited; customer accounts still in use. Kept records are reported ("Kept 1 customers … that were used since") with up to 10 examples. Customers the import only matched are never removed (blanks it filled stay filled). A pending `chase_imported_balances` question is withdrawn.

### Owner tools (`owner-tools.ts`)

- `send_import_link`: texts the owner the link.
- `import_status`: the last 3 imports (status, new / matched customers, past jobs, balances, rows skipped, undo summary), balances on hold and any pending question. `start_reminders: true` creates the `chase_imported_balances` approval inline ("#12 … Reply Y 12 to approve, N 12 to skip.") or points at the pending one.

### Settings, routes

`companies.ai_settings.import = { enabled? }` — **on** for CrankLeads orgs, **off** for house orgs (A1 sees no tools or notes, can't upload, and the sweep leaves any batch of a company that has it off alone until it started importing). Routes (owners/admins; the overview is readable by members):

- `GET|PATCH …/companies/:company/ai-settings/import`
- `GET|POST …/companies/:company/imports`, `GET|POST …/imports/:batch` (`uploaded`, `mapping`, `import`, `undo`, `cancel`), `POST …/imports/send-link`, `POST …/imports/start-reminders`
- `GET|POST /api/public/import/:token`, `GET|POST /api/public/import/:token/:batch` (same actions; the token's company only)

### Data (migration `20261012110000_staff_importer.sql`)

- `import_links` (service role only), `import_batches` (owners/admins read — samples hold raw customer rows, like the API; statuses uploading → uploaded → mapped → previewed → importing → done, failed, undoing → undone, cancelled), `import_rows` (service role only; unique `(batch_id, row_hash)`; what each row created).
- `invoices.imported_at / import_batch_id / import_hold / import_key` (no client grants), unique `(company_id, import_key)`; unique `(company_id, source_call_id)` for `bookings` with an `import:` key; an index on `contacts.metadata->import->>batchId`.
- Bucket `customer-imports` (private, 10 MB, CSV / XLSX types).
- `accounting_enqueue_invoice` / `accounting_enqueue_payment` skip imported balances (the rollback restores the originals).

30 days after a batch is finished the sweep deletes its file and the raw rows' cells (the records it made stay; undo still works). Local row types: `staff/importer/db-types.ts`.

Env: `AI_MODEL_IMPORTER` (optional, default `claude-sonnet-5-5`). Dependency: `exceljs` 4.4.0 (exact).

Tests: `src/test/staff-importer.test.ts` (CSV/XLSX reading, the export heuristics and the Claude fallback, row cleaning, settings + house orgs, preview, the quiet import with consent fields and fill-blanks matching, the no-messages guarantee, quiet hours, idempotent re-upload, chunk resume, leases, the holds against the email and Bookkeeper sweeps, `chase_imported_balances` through `decideApproval` (Y, note, N), undo, owner tools, the token route).

Customer accounts match by name in any case ("ORTIZ HOLDINGS" is "Ortiz Holdings").

**Not yet:** XLS (old Excel) files must be saved as XLSX or CSV first.

## Keep your number

The owner keeps their existing business number: it moves (ports) from their carrier to our Twilio account, and calls to it ring the owner's cell first, then the AI. No more call forwarding. Twilio accepts Canadian local port-ins **only through its web form** (no API), so everything is automated except one operator step: pasting the details into that form. Code: `src/server/services/staff/porting/`. Migration: `20261012120000_staff_porting.sql` (rollback in `supabase/rollback/`).

### What the owner sees

1. **Start.** Settings → AI front desk → Keep your number → **Keep (705) 555-0142**, or by text: "can I keep my number?" (owner tool `start_number_port`, whose reply carries the link). An operator can also start one (concierge action **Keep their number: text the owner the porting form**). One open request per company: asking again returns the same link. The owner gets, from the platform number: `Keep your number: to move (705) 555-0142 over we need a few details (about 5 minutes - have a recent phone bill handy): https://…/port/<token> Your calls keep working the whole time.`
2. **The form** (`/port/:token`, public, the token is the credential, mobile-first): the number(s) (prefilled with the business line; up to 5 on the same account; a warning when the business line is a cell), the current carrier, the name on the account, the authorized person, the account number, the PIN (or "my account doesn't have a PIN"), the **service address** (no PO boxes, Canadian postal code / US ZIP checked), a photo or PDF of a **bill from the last 30 days** (straight to the private `porting-docs` bucket through a one-time signed upload URL), and a **typed-signature e-sign** of the Letter of Authorization (the typed name must match the authorized person). On submit the server generates the LOA PDF (`loa.ts`, pdf-lib: business, authorized person, service address, carrier, numbers, the authorization text naming Twilio Inc. as the new provider, the typed signature, date, IP and browser; **the account number and PIN are never printed on it**), stores it with its SHA-256, and the request becomes `ready`: `Got it - everything's in for moving (705) 555-0142. We'll send it to your carrier within 1 business day and text you when it's in.`
3. **Submitted** (operator): `Your number move for (705) 555-0142 is in with the carrier (usually 5-7 business days). Don't cancel your old phone service - the move ends it for you. Your carrier may text you asking to approve the transfer: answer YES within 90 minutes or it gets rejected.` This one (and the FOC one) goes out **even in quiet hours**: the carrier's approval text can come minutes after submission.
4. **Move date set:** `(705) 555-0142 moves over on Tue, Oct 20. Keep your old service until then - calls work the whole time. Your carrier may text you asking to approve the transfer: answer YES within 90 minutes or it gets rejected.`
5. **Rejected:** `Your carrier sent back the move for (705) 555-0142: <operator's reason>. Fix it here and we'll send it again: <same link>` The form reopens with the reason on top; re-signing makes it `ready` again (the stored account number / PIN are kept unless retyped).
6. **Done:** `Done: (705) 555-0142 now rings through us. Calls ring your cell first for 20 seconds (press 1 to take one), then your AI answers. You can turn call forwarding off now - it isn't needed any more.` (Voicemail-mode companies: "…then they get your voicemail and a text back".)
7. **Cancelled:** `Your number move for (705) 555-0142 was cancelled. Nothing changes: your phone works as before.` Owners can cancel from Settings until it's submitted; after that an operator cancels (and cancels at Twilio).

Owner texts are never more than numbers, dates and what to do: never the account number or PIN. Each status change owes exactly one text (`notify_status` = `"<status>@<time>"`, claimed by a conditional update on `notified_status`, and cleared once sent — or once it can never be sent: owner opted out, no verified cell); non-urgent ones wait for 08:00 local (quiet hours 21:00–08:00), and a failed send is retried by the `porting:notify` sweep, which only ever sees pending texts (oldest first). `number_port_status` (owner tool) answers "where's my number move at?".

### Account number and PIN

- Encrypted at rest with **AES-256-GCM** (`crypto.ts`), key `PORTING_ENCRYPTION_KEY` (32 random bytes, base64), a fresh 12-byte IV per value, and the port row's id as additional authenticated data (a ciphertext copied onto another row won't decrypt). Stored as `v1.<iv>.<tag>.<data>`; only the last 4 digits of the account number are kept in clear for display.
- **No key (or a malformed one) → neither is collected in the app**: the form says "We'll call you for your account number and PIN" (`pin_status = 'call'`) and the operator calls the owner. (Stricter than the brief, which only required this for the PIN: storing the account number in clear would break "encrypted at rest".)
- Never logged, never in a text, an approval, the settings view, the form view, the operator queue or an audit row. The only way to read them is the concierge action **Reveal account number + PIN** (`port_reveal_secrets`), which runs through the audited concierge runner: the `operator_actions` row records who revealed them and when (`revealed: { accountNumber: true, pin: true }`), never the values.
- **Purged** by the `porting:purge` sweep 14 days after the port completes or is cancelled: the ciphertexts are nulled, `secrets_purged_at` is set, and **every** `bill-*` file in the port's storage folder is deleted (the current bill, replaced ones and uploads that were never submitted — they show the account number). A bill replaced on the form is also deleted right away. The signed LOA is kept as the record.
- **Abandoned ports** (collecting / ready / rejected, untouched for **60 days**, `ABANDON_AFTER_MS`) are cancelled by the same sweep (the owner gets the "cancelled" text), so their details and bill are purged 14 days later.

### Port requests (`number_port_requests`)

Status `collecting → ready → submitted → foc_scheduled → completed`, or `rejected` / `cancelled` (`status.ts PORT_TRANSITIONS`; every change is a conditional update on the current status, so two operators can't both win):

| From | To |
| --- | --- |
| collecting | ready (owner signs), cancelled |
| ready | ready (re-signed), submitted, rejected, cancelled |
| submitted | foc_scheduled, rejected, completed, cancelled |
| foc_scheduled | foc_scheduled (new date), rejected, completed, cancelled |
| rejected | ready (owner fixes + re-signs), cancelled |

Also recorded: carrier, numbers, business name, authorized name, service address, bill path / type / upload time, LOA path / SHA-256 / signed time / typed name / IP / user agent, Twilio port request id, FOC date, rejection reason, attached numbers, who started it (`settings | owner_text | operator`), and a timestamp per status. **The owner's form locks** as soon as an operator starts on the port — the first copy on the Ports page (concierge action `port_opened`), a reveal, an LOA / bill download, or Mark submitted (`operator_opened_at`) — so what goes into Twilio's form is what was signed; Mark rejected reopens it. A locked or submitted link shows only the status (no personal details); 30 days after the port ends the link stops working.

**Numbers a port may never touch** (`guards.ts`, checked on the form, on start, and again in the completion sweep): the platform number (`PLATFORM_SMS_NUMBER`, `TWILIO_FROM_NUMBER` — a house business's line such as A1's, which may have no `voice_numbers` row — and `TWILIO_FORWARDING_TEST_FROM`); any number with a `voice_numbers` row unless it's already this company's `business_line` (a catcher row is never converted; the form says "already connected to us").

### The operator step (concierge → **Number ports**, `/concierge/ports`)

Linked from the concierge list header. Every open port (ready first), each with:
- **Copy for Twilio form:** numbers (E.164), billing telephone number, losing carrier, business name, authorized representative, service address (street, city, province, postal code, country), account number (`ending 9012 - reveal`), PIN (on file / none / call the owner), LOA signed (who, when), the owner's cell (for the carrier's approval text). One copy button per field and **Copy all**.
- **Signed LOA** and **Phone bill** downloads (`GET /api/concierge/ports/:portId/files/loa|bill` → a 2-minute signed URL; each download is an `operator_actions` row).
- **Reveal account number + PIN** (confirm, audited, shown in the panel only).
- **Mark submitted** (with the Twilio port request id), **Set FOC date**, **Mark rejected** (reason, texted to the owner), **Cancel port**. These are concierge actions `port_mark_submitted`, `port_set_foc`, `port_mark_rejected`, `port_cancel` (strict zod input, the port must belong to the named org + company, audited). They're hidden from the account page's generic action buttons (they need a port id); `port_start` stays there.
- Warnings: LOA or bill over 30 days old (mark rejected so the owner re-signs / sends a newer bill), "call the owner for the PIN", "purged".

### Completion (`completion.ts`, sweep `porting:completion`, hourly)

For each `submitted` / `foc_scheduled` port, each number not yet attached is looked up with the injected Twilio provision client's `listIncoming({ phoneNumber })`. When it appears in the account:
1. **Mark submitted snapshots the Twilio account** (`listIncoming` for each number, `twilio_snapshot_at`, `preexisting_numbers`; it refuses to submit if Twilio can't be checked). Only numbers that **arrive** after that are attached: one already in the account at submit, or a port with no snapshot, is never auto-attached (the Ports page warns; an operator attaches it by hand).
2. Guards before anything is touched (each refusal logged): not a platform number; no `voice_numbers` row unless it's this company's `business_line`; not FriendlyName-tagged `EmpireVu catcher …` or `EmpireVu line <another company>`; webhooks unset (or Twilio's demo URLs) or already pointing at our `/business-line` route — anything else means the number is in use.
3. Its Voice URL → `/api/twilio/voice/business-line`, SMS URL → `/api/twilio/sms/inbound`, FriendlyName `EmpireVu line <companyId>` (distinct from the catcher tag, so it can never be claimed as a catcher).
4. A `voice_numbers` row (`provider = 'twilio'`, **`mode = 'business_line'`**, the number's SID, active) for the company.
5. When every number is in: `completed` + the owner's "Done" text. Idempotent (a second pass finds nothing to do). Missing Twilio credentials or `APP_BASE_URL` → the pass is skipped and logged.

Call forwarding stays in place until the port completes (the old carrier's service, and with it the forwarding, ends with the port); the "Done" text tells the owner they can turn it off.

### Calls to the ported line (`business-line.ts`, route `/api/twilio/voice/business-line`)

Signature-verified first (403 otherwise); the tenant comes only from the called number (`voice_numbers` mode `business_line`, active).
1. **Ring the owner first:** `<Dial timeout="20" answerOnBridge="true" callerId="<caller>" action="…?stage=after">` to the owner's cell (`companies.owner_phone_e164`, **only when verified** — an unverified cell is never rung; the call goes straight to step 3 and Settings says so), plus team members' cells (`organization_memberships.phone_e164`; only this company's people when `company_memberships` rows exist for it, oldest member first) when **Ring my team's cells too** is on — owner first, deduplicated, at most 5, and never one of our own numbers (the ported line itself, the catcher, the platform number: an owner whose "cell" *is* the ported line goes straight to step 3). The caller hears ringing; the owner sees the caller's number. Nothing is queued as a missed call yet (`business_line_calls` row only).
2. **Press 1 to take it** (on by default): each ringing leg gets `<Number url="…?stage=screen&parent=<CallSid>">` → `Call for Northshore Plumbing. Press 1 to take it.` 1 bridges the call and records `accepted_at`; anything else drops only that leg. So a cell's own voicemail never swallows a customer.
3. **`<Dial>` ends** (`?stage=after`): answered = `DialCallStatus=completed` and (Twilio's `DialBridged=true`, or screening off, or someone pressed 1; `DialBridged=false` never counts) → `<Hangup/>`. Anything else (no answer, busy, voicemail picked up without pressing 1) → `<Redirect>` to **`/api/twilio/voice/inbound` — the existing catcher path, unchanged**: the durable job, AI answering (or the greeting + voicemail) and the missed-call text-back. Any error on our side (tenant lookup, DB) also falls through there, so a caller is never lost.

The only change to that path: `resolveCatcherTenant` (twilio/missed-call.ts) now matches `mode in ('missed_call_catcher', 'business_line')`, so the redirected call (and its worker job) resolves the company from the ported number. Catcher numbers behave exactly as before (tests: golden greeting TwiML, durable-first ordering, forwarding-test legs).

**Texts** to the ported number need nothing new: inbound SMS already routes any active Twilio `voice_numbers` row (owner → owner channel, customer → the SMS agent), exactly like the catcher number. Outgoing texts still go from the catcher number (`resolveCompanySmsFrom` prefers it); see Not yet.

### Settings

`companies.ai_settings.porting`, read only by `staff/porting/settings.ts readPortingSettings`:

```
porting = {
  enabled,                                   // CrankLeads on, house orgs off
  ring: { enabled: true, seconds: 20,        // 10–40
          crew: false, screen: true }
}
```

Route `GET | PATCH | POST /api/organizations/:org/companies/:company/ai-settings/porting` (members read — without the form link; owners/admins PATCH `{ enabled?, ring?: { enabled, seconds, crew, screen } }` merged into `ai_settings.porting` only via `updateAiSettings`; POST `{ action: "start", number? }` or `{ action: "cancel", portId }`). UI: `src/components/settings/staff/PortingSettingsSection.tsx` — the switch, **Keep (705) 555-0142**, the port's status with the form link and Cancel, the ported line(s), and the ring settings. `portingActiveFor` = `enabled`, so house orgs (A1) never see the owner tools or the prompt note. House orgs can't have a `business_line` number unless an operator ports one for them, so their calls are untouched.

### Owner tools

| Tool | Does |
| --- | --- |
| `start_number_port` | Starts (or finds) the request; `tell_owner_exactly` = the form link. Already underway → where it stands. |
| `number_port_status` | Numbers, status, move date, the carrier's feedback, the next step, the form link while open. |

Prompt note: relay `tell_owner_exactly` word for word; never ask for or repeat the account number or PIN by text; don't cancel the old service; answer the carrier's text YES within 90 minutes. No SMS-agent tools, **no approval kinds** (nothing here acts on a customer or on money).

### Schema (`20261012120000_staff_porting.sql`)

- `voice_numbers.mode` check gains `business_line`.
- `number_port_requests` (above; unique `token`; one open request per company via a partial unique index on `company_id` where status is open).
- `business_line_calls` (unique `call_sid`: who was rung, screened or not, `accepted_at`, outcome `answered | missed`).
- Private bucket `porting-docs` (10 MB; PDF, JPEG, PNG, WebP, HEIC/HEIF) with **no storage policies** (service role only, signed URLs).
- Both tables: RLS on, **all** privileges revoked from `anon` and `authenticated` — every read goes through owner/admin, public-token or operator server routes.
- Rollback converts `business_line` rows to `missed_call_catcher` (so calls and texts keep resolving the company; re-point those numbers' Voice URL to `/api/twilio/voice/inbound` if the app code is rolled back too), restores the old mode check, drops both tables and the bucket (empty it first).

Types: `staff/porting/db-types.ts` until merged into `database.types.ts`.

### Env

`PORTING_ENCRYPTION_KEY` — 32 random bytes, base64. Generate one with `openssl rand -base64 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Set it on the **web** service (the form encrypts, the concierge decrypts). Keep it stable: changing it makes stored values unreadable (the reveal says so; the operator calls the owner). Also uses the existing `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `APP_BASE_URL` (or `TWILIO_WEBHOOK_BASE_URL`) on the **worker** for the completion sweep. No AI model calls.

### Sweeps

`porting:completion` (1 h), `porting:notify` (5 min), `porting:purge` (1 h; also cancels abandoned ports) — through `runStaffSweeps`; each reads only ports in the relevant statuses.

### Tests

`src/test/staff-porting.test.ts` (fake DB; owner text, storage and Twilio faked): encryption (round trip, row binding, wrong key, bad key), settings defaults + merge + `activeFor` (house org off), the status machine and every owner text, start (one per company, owner-text start doesn't double-text, house org refused unless operator), the form end to end (ciphertext only, LOA PDF in the port's folder without the account number, owner text), PO box / signature / bill-path / number validation, no-key mode, the public route (secrets never echoed), the link after submission and its 30-day expiry, operator steps (90-minute warning at night, FOC, rejected → fixed → ready, wrong company refused), quiet-hours hold + notify sweep, failed-text retry, owner cancel rules, the concierge queue + audited reveal (no values in the audit), completion (waits, attaches `business_line`, webhooks, catcher untouched, owner text, idempotent, never another company's number), purge timing, sweeps registered. `src/test/staff-porting-calls.test.ts` (real routes, signed requests): ring owner first (golden TwiML, nothing queued), crew + seconds + unscreened, never ringing our own numbers, fall-throughs, screening (1 bridges, 2 drops), answered vs voicemail-picked-up vs no-answer, the redirected call taking the catcher path (durable job + greeting), **catcher path unchanged** (golden greeting, durable-first, forwarding-test legs, unknown/inactive numbers), and SMS to the ported line reaching the SMS agent. `src/test/porting-settings-section.test.tsx`: the Settings section.

### Not yet

- Never run against live Twilio: check the first real port by hand — that the number appears in `listIncoming` after the FOC, that `<Number url>` screening and `DialBridged` behave as documented, and that `callerId` = the caller's number is accepted for Canadian destinations (if Twilio refuses it, drop `callerId` so the owner sees the business line).
- Outgoing texts still come from the catcher number. Switching the sender to the ported line (so replies come "from the business number") is a one-line change in `resolveCompanySmsFrom`, left out until the ported number's messaging is confirmed on Twilio.
- The setup checklist, the concierge account page and the forwarding checks still describe the company by its catcher number + forwarding; they don't show the ported line (Settings → Keep your number and the concierge Number ports page do). A forwarding test run by hand after the port would fail (the old carrier line is gone) — don't run one.
- The bill's own date isn't read (the owner confirms "from the last 30 days"; the operator sees the upload date).

## Hiring & payroll

The Recruiter does the office's hiring and payroll paperwork. It turns the crew's clock-ins into a payroll the owner OKs by text, with Ontario overtime flagged. Y locks the hours and emails a CSV the bookkeeper can load into any payroll tool. It also writes job posts, puts them on the company site with an apply form, sorts applicants against the job's own requirements, and sets up calls once the owner says yes. Code: `src/server/services/staff/recruiter/`. Migration: `20261012130000_staff_recruiter.sql` (rollback in `supabase/rollback/`).

### What the owner sees

- **Monday 08:00, the morning after a pay period ends**, one text from the platform number:

  > #12 Payroll Sep 28 - Oct 11: Ana 40h, Jo 6h, Mike 82h (OT 6h). Total 128h, OT 6h flagged (over 44h/wk). Y locks these hours and emails the CSV to books@acct.ca. Reply Y 12 to lock it and send the CSV, N 12 to skip.

  **Y 12** locks the period's time entries and emails `northshore-roofing-payroll-2026-09-28-to-2026-10-11.csv` to the bookkeeper email (or the account owner). The owner gets back "Locked payroll Sep 28 - Oct 11 (3 people, 128h, OT 6h) and emailed the CSV to books@acct.ca."
- **Someone forgot to clock out.** The text adds "1 open entry (no clock-out): Ana Tue Oct 6." and the reply line becomes "Fix the open entry in the app and reply Y 12, or reply Y 12 anyway to lock as is. N 12 to skip." A plain **Y** while it's still open locks nothing; it asks again with a fresh code: "Not locked yet: 1 open entry with no clock-out (Ana Tue Oct 6). Fix it in the app, then reply Y 13 - or Y 13 anyway to lock as is (open entries count as 0)." **Y 13 anyway** locks it, and the open entry counts as 0 in the CSV with a note.
- **"I need a labourer, $22/hr, start Monday"** (to the assistant): `start_hiring` drafts the post and the reply is the question:

  > #14 Job post "Labourer" - $22/hr, Full-time, start Monday, Midland. Duties: …; …. Needs: …; …. Form also asks: "Do you have your Working at Heights ticket?". Y publishes it on your website with an apply form and texts you copy for Indeed/Facebook. Reply Y 14 to post it, N 14 to skip.

  **Y 14** opens `/s/<slug>/jobs/<id>` (or `pages.crankleads.com/<slug>/jobs/<id>`). The owner gets "Posted the Labourer job: <link>. Copy for Indeed/Facebook is in my other text. …", plus a second text: "Copy for Indeed/Facebook: Northshore Roofing is hiring: Labourer ($22/hr, …). You'll: …. You need: …. Apply here: <link>".
- **Applicants** fill in the form: name, cell, email, experience, availability, driver's licence and own vehicle (yes/no), plus up to 3 job questions. Each one gets "Hi Jo, thanks for applying for the Labourer job at Northshore Roofing. We got your application and we'll be in touch." from the business number.
- **08:30 the next morning** (only when there are new applicants):

  > Hiring (Northshore Roofing): 5 new applicants for Labourer. Top: Jo P. 5/5 - 3 yrs roofing, has licence; Sam L. 4/5 - …; +3 more. I'll ask you about inviting the top 3. Text "applicants" for the full list.

  This is followed by up to 3 `interview_invite` approvals a day: "Invite Jo Park (705-555-0142) to talk about the Labourer job? Score 5/5 - …. Y texts them: "Hi Jo, Northshore Roofing would like to talk about the Labourer job. When's a good time for a quick call this week?" Their reply comes to you." On **Y** Jo gets exactly that text, and the reply comes to the owner, not the AI.
- **By text any time:** "who applied?" (`applicants`), "invite Sam" (`invite_applicant`), "close the labourer job" (`close_job`).
- **House orgs (A1 etc.)** get none of this unless the owner switches it on in Settings → AI front desk → Hiring & payroll.

### Payroll

- **Periods** (`periods.ts`, pure): weekly or bi-weekly from the anchor date (the first day of any one period, default Mon 2026-01-05), or semi-monthly (1st–15th, 16th–end of month). Dates are the company's local calendar days; `starts_at` / `ends_at` are local midnights (DST-safe).
- **Hours** (`computePayroll`): `time_entries` → `time/logic.ts workedMinutes` (breaks subtracted). An entry counts on the local day it starts.
  - Which entries are the company's: `company_id` = the company, plus general time (`company_id` null) when the period has `covers_general_time`.
    - That flag is set when the period is created, for the org's oldest company with payroll on (`generalTimeCompanyId`). The lock (service check and trigger) follows the same flag, so what's paid is exactly what's locked.
    - A multi-company org never counts the same hours twice.
  - **Open entries** (no clock-out) count as 0 and are listed by person and day.
  - **Edits since the period ended**: an entry added after the end, or changed after it. A clock-out written within 10 minutes of the change doesn't count, so a shift that ran past midnight isn't flagged.
  - Job count = distinct bookings.
- **Ontario overtime** — a *flag*, never a payroll calculation:
  - Hours past 44 in a work week are flagged at 1.5×. The week is **per worker across the whole org**: all their companies and general time count toward the 44, and the hours past it are flagged where they fell (30 h at one company then 30 h at another → 16 h OT at the second).
  - The work week starts on the anchor's weekday (weekly / bi-weekly) or Monday (semi-monthly).
  - A work week that straddles the period start counts the earlier days toward the 44. That keeps semi-monthly periods right.
  - No averaging agreements, exemptions, vacation pay or tax.
- **The sweep** (`payroll.ts runCompanyPayroll`, `recruiter:payroll` every 5 min):
  - It runs from 08:00 local on the day after the period ends, caught up for 2 days.
  - The `pay_periods` row (unique company + start date) is the claim, so each period is asked about once across workers.
  - A period that would overlap an earlier one (the frequency or anchor changed) is skipped (`overlap`). The `pay_periods_no_overlap` trigger is the backstop.
  - A period with no hours becomes `empty` and nothing is asked. A failed read deletes the claim so a later pass retries.
  - Otherwise it creates a `payroll_period` approval (72 h), notified through `notifyOwnerOfApproval` (quiet hours respected), and the period becomes `awaiting_owner`.
- **The lock**:
  - `time/service.ts` (`createManualEntry`, `updateEntry`, `deleteEntry`) checks `staff/recruiter/time-lock.ts` first. A locked entry gives a plain `PayPeriodLockedError`: "Those hours are locked for payroll. An owner or admin can unlock the pay period in Settings > AI front desk > Hiring & payroll."
  - The `time_entries_pay_period_lock` trigger is the backstop. It refuses any client (browser session) insert, edit or delete inside a locked period (`pay_period_locked`, mapped to the same message).
  - **Exception:** stopping a clock that was left running is always allowed, so a period locked "anyway" never strands a running clock.
    - The timesheet dialog re-sends every field, with the start at minute precision. Unchanged values (start in the same minute, same break, same job) aren't treated as changes, in the service and in the trigger.
  - General-time entries are covered only by the locked period with `covers_general_time`.
  - The trigger is SECURITY INVOKER and checks `pay_periods` inline, which members can read under RLS. `time_entry_in_locked_period` is service-role only.
  - The service role and `close_job_time_entries` (SECURITY DEFINER) aren't affected.
- **Unlock / lock from Settings**: `POST /api/organizations/:org/companies/:company/payroll/periods/:periodId { action: "lock" | "unlock", reason? }` (owners/admins).
  - Unlock clears the email claim, so re-locking emails a fresh CSV.
  - Every ask, lock, unlock, CSV email, CSV download and skip is a `pay_period_events` row with who did it (`owner_sms:+1…`, `profile:<uuid>`, `system`).
- **CSV** (`payrollCsv`): one row per person with columns `employee_name, employee_email, period_start, period_end, regular_hours, ot_hours, total_hours, hourly_rate, gross_estimate, job_count, notes`.
  - Hours are decimals. The rate comes from `member_pay_rates`.
  - Gross = regular × rate + OT × 1.5 × rate. It's an estimate before deductions.
  - Notes: the OT flag, open entries not counted, changed after the period, no pay rate.
  - Cells are formula-safe (`csvCell`: a leading `= + - @`, tab or carriage return is neutralised, and any `\r` is quoted).
  - Download any period: `GET …/payroll/periods/:periodId/csv` (owners/admins). It's computed fresh from the entries.
  - The email (Resend `sendEmail` with the CSV attached, sent under the business's name) is claimed by `csv_emailed_at`. A failure still locks, records `csv_email_error`, and tells the owner where to download it.

### Approval kinds

| Kind | Created by | Y | N / expiry |
| --- | --- | --- | --- |
| `payroll_period` | the payroll sweep (72 h); an executor re-ask when entries are still open (asked inline to the phone that said Y) | recomputes the hours. Open entries without "anyway" → a fresh `payroll_period` with a new code and the period re-pointed to it; nothing is locked. Otherwise: conditional `status → locked`, CSV email, "Locked payroll … and emailed the CSV to …" | `skipped` / `expired`, nothing locked ("You can lock it or download the CSV in Settings") |
| `job_post` | owner tool `start_hiring` (asked inline, 48 h) | `awaiting_owner → open` (conditional), the paste copy is texted to the owner once (`owner_texted_at` claim) | `rejected` / `expired` ("Text me what to change … and I'll redraft it") |
| `interview_invite` | the 08:30 digest (≤ 3 a day; notified normally) or owner tool `invite_applicant` (inline), 48 h | `invited_at` claimed, the exact invite is texted from the business number, and the conversation goes to the owner (an applicant-only contact stays AI-paused; anyone else gets `markOwnerTakeover`). Outside 08:00–21:00 local it's queued (`invite_send_after` = the next 08:00) and the owner is told "It's late, so I'll text Jo … at 8am"; the `recruiter:applicants` sweep sends it, and texts the owner if it can't | nothing sent |

"Y 12 anyway" is a new decision note. `parseApprovalReply` accepts `anyway` after a yes. `owner-channel/entry.ts` only treats it as a decision when a `payroll_period` (`ANYWAY_NOTE_KINDS`) is pending for that phone, matching the code if one was given. Otherwise ("ok anyway" in a house org, "Y 3 anyway" on a quote, nothing pending) the text takes exactly the pre-change path ("did you mean" / command), and `looksLikeApprovalAttempt` judges it as before. `replyInstruction` has lines for the three kinds. Every executor is idempotent: a second Y is "already" (owner channel), and a re-run sends nothing (conditional claims).

### Hiring

- **Drafting** (`ai.ts draftJobPost`, model `AI_MODEL_RECRUITER`, default `claude-sonnet-5-5`, usage recorded):
  - The input is the owner's words, fenced as data, plus the business name, trade and service area. The model returns JSON (title, pay, type, start, location, summary, 3–6 duties, 2–5 requirements, nice-to-haves, up to 3 job questions).
  - **Pay** is kept only when every amount in it is one the owner typed (`checkedPay`). It's never invented. With no pay, the owner's text says so.
  - **Human rights guard** (`protectedGroundProblems`): any line touching a ground protected by the Ontario Human Rights Code is dropped. That covers age ("young", "under 35", "recent grads"), sex/gender ("men", "handyman"), family/marital status, origin/citizenship/ancestry ("native English speaker", "Canadian-born"), creed, disability ("able-bodied"), sexual orientation and public assistance. So is "Canadian experience". Job-related lines stay: "lift 50 lbs", "18 or older", "Working at Heights", "G licence", "10-15 years of experience".
  - No model, a bad answer or a title that fails → a plain template from the owner's words (`templateJobDraft`).
  - One draft waits at a time. A new `start_hiring` marks the old one `rejected` and supersedes its approval.
- **Public pages** (`public.ts`, `jobs-render.ts`; routes `src/app/s/[slug]/jobs/route.ts` and `…/jobs/[jobId]/route.ts`):
  - They're served only for a `published` `company_sites` row whose company has hiring on. The company comes from the slug row only.
  - A closed job answers 410 "This job is closed". Anything else gets the site's neutral 404.
  - The pages use the site's colours, and every value goes through `esc` / `safeHref`. Each job page says "This is a current opening." and "We use AI to help sort applications. A person reads every one and makes every decision." (in line with Ontario's 2026 job-posting rules for larger employers).
  - The apply form is a plain HTML POST to the same URL (no JS needed). The page carries its render time, so the timing check works without JS.
  - POST checks: a streamed 16 KB body cap, rate limits (6/hour per IP, 200/hour per job, 5/day per phone across jobs and businesses), honeypot + 3-second minimum fill (a missing render time fails), and Turnstile when configured.
  - `site-host.ts` now rewrites `pages-host/<slug>/jobs[/<uuid>]` to these routes.
  - The Indeed/Facebook paste copy always ends with how to apply, "This is a current opening." and the AI disclosure. Only the job details are clipped to fit 560 characters.
  - A post with no pay: the approval text says Ontario requires the pay or a pay range on public posts and asks the owner to reply N and text it (e.g. "$22-$25/hr"). Ranges are kept as given.
  - With no live website, the post still opens. The paste copy says "text <business number>", and texts come to the business line, where the prompt note below applies.
- **Applying** (`applicants.ts submitApplication`):
  - `job_applicants` has one row per job + E.164 phone. Applying again refreshes the answers (re-screened), with no second text.
  - The contact is matched by phone (last 10). A **new** contact is inserted directly, with no `contact.created` event, so no lead automation fires. It gets `metadata { kind: "applicant", applicant_job_ids }`, `consent_source 'job_application'`, and its conversation is set to `paused`: their texts reach the owner through the customer-text relay and never go to the AI as a customer.
  - An **existing** contact (a customer who applies) keeps its details and its AI. Only `applicant_job_ids` is added.
- **Sweeps never stall**: screening reads only companies with hiring on and rows with attempts left (a row whose job is gone uses its attempts up). Confirmations and queued invites read only companies inside their texting hours.
- **Confirmation text**: from the company's own number only (no number → `skipped`), 08:00–21:00 local. Later applications wait for the `recruiter:applicants` sweep the next morning, and are dropped after 2 days.
  - It's transactional (they asked), so opt-outs always win and no 6-month consent expiry applies.
  - Claimed `pending → sending → sent/skipped/failed`. `message_log.sent_by = 'recruiter'`.
- **Screening** (`screenApplicant`, `recruiter:applicants` sweep, 20 a pass, at most 3 attempts, the attempt counted before the call):
  - It scores 1–5 **only against the job's stated requirements, nice-to-haves and duties**.
  - The model never sees the name, phone or email. Answers are fenced as `<applicant_answers note="data">` with angle brackets stripped. Volunteered ages ("I'm 45", "born in 1974") are redacted.
  - The prompt forbids considering any protected ground or where experience was gained.
  - A reason that mentions a protected ground is replaced with the met requirements. No model or a bad answer → `ruleScreening` (licence / vehicle answers against the requirements, how much experience was written).
  - **Nobody is ever rejected automatically.** The score only orders the owner's list.
- **Digest** (`runCompanyDigest`, `recruiter:digest` every 5 min):
  - It runs from 08:30 to 11:00 local, only with new applicants on open jobs and a verified owner cell. It's claimed per local day in `recruiter_sweep_claims`.
  - The owner gets the text, then every included applicant gets `digest_at`, then interview invites are created for the best ones not yet invited. Invites created by the Recruiter that day count toward the cap of 3. A failed owner text releases the day.
- **SMS agent prompt note**: "Job applicants …". If the person is asking about a job, an application or an interview, or the history shows the business's applicant texts, the agent never quotes, books or sells, never asks anything personal, and calls `hand_off_to_owner`.

### Owner tools

| Tool | Does |
| --- | --- |
| `start_hiring` | `request` (the owner's words), optional `title` / `pay` / `start` / `location` → draft + `job_post` approval. Returns `tell_owner_exactly` (≤ 470 chars, with the code). |
| `applicants` | Open jobs (or the one named): link, count, new since the digest, the top 8 with score, reason, phone, licence/vehicle, invited. Applicant-written text (name, reason) is quoted, stripped of markup and labelled as data. |
| `invite_applicant` | `applicant` (name words), optional `job` → `interview_invite` (inline). Ambiguous names list the matches. |
| `close_job` | Closes an open job (by title words, or the only one). The page answers 410. |

Owner prompt notes tell the agent to relay `tell_owner_exactly` word for word, never invent pay, never judge applicants on anything personal, and that payroll locking and unlocking happen by the payroll text or in Settings, not by command.

### Settings

`companies.ai_settings.recruiter`, read only by `staff/recruiter/settings.ts readRecruiterSettings`:

```
recruiter = {
  payroll: { enabled, frequency: "weekly" | "biweekly" | "semimonthly", anchor_date: "YYYY-MM-DD", csv_email },
  hiring:  { enabled },
  any_on:  boolean   // written by mergeRecruiterSettings: the sweeps' server-side filter for house orgs
}
```

- Both switches default **on** for CrankLeads orgs and **off** for house orgs.
- The defaults are bi-weekly from 2026-01-05. The CSV goes to the org owner's email when no `csv_email` is set.
- Route: `GET | PATCH /api/organizations/:org/companies/:company/ai-settings/recruiter`.
  - Members read the settings only. Pay periods, jobs and the fallback email are for owners/admins.
  - Owners/admins PATCH `{ payroll?: { enabled, frequency, anchorDate, csvEmail (""/null clears) }, hiring?: { enabled } }` (strict; a real date and email). It's merged into `ai_settings.recruiter` only.
- UI: `src/components/settings/staff/RecruiterSettingsSection.tsx`.
  - Payroll on/off, the pay period, the anchor, and the CSV email.
  - Recent pay periods, each with **CSV**, **Unlock** (asks first) and **Lock & email**.
  - Hiring on/off, a note when the website isn't live, and the job posts with applicant counts and links.

`recruiterActiveFor(admin, { organizationId, companyId })` is true when payroll or hiring is on. The registry uses it to offer the owner tools and prompt notes only there.

### Schema (`20261012130000_staff_recruiter.sql`)

- `pay_periods`: unique `(company_id, start_date)`.
  - Columns: status `pending | awaiting_owner | locked | unlocked | skipped | expired | empty`, company-level totals (people, minutes, OT, open entries; no per-person hours), lock / unlock / CSV-email fields.
  - **Every member may read** it (dates and status only), so the timesheet service can say "locked".
- `pay_period_events`: the audit log. Owners/admins read.
- `job_postings`: status `draft | awaiting_owner | open | closed | rejected | expired`, duties / requirements / nice-to-haves / questions as jsonb. Members read.
- `job_applicants`: unique `(job_id, phone)`, with score, reason, screening, the confirmation claim, `digest_at` and the invite fields. **Owners/admins only** (personal information).
- `recruiter_sweep_claims`: service role only.
- `time_entry_in_locked_period(org, company, at)` (SECURITY DEFINER, `authenticated` + service role) and the SECURITY INVOKER trigger `time_entries_pay_period_lock`. It's invoker on purpose, so `is_client_role()` sees the caller.
- Nothing is client-writable. SQL checks: `scripts/sql-tests/zz_recruiter.test.sql` (privileges, plus the lock: deny edit / delete / backdated insert in a locked period, allow stopping a running clock, allow after unlock, the service role unaffected).

Types: `staff/recruiter/db-types.ts` until merged into `database.types.ts`.

### Env

`AI_MODEL_RECRUITER` (default `claude-sonnet-5-5`), `ANTHROPIC_API_KEY` (without it, job posts use the template and screening uses the rules), `RESEND_API_KEY` + `OUTBOUND_FROM_EMAIL` (the CSV email; already set), optional `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` (the apply form), `PAGES_BASE_URL` (already set for the generated sites).

### Sweeps

`recruiter:payroll` (5 min), `recruiter:applicants` (2 min: screening, confirmation texts, invites queued overnight), `recruiter:digest` (5 min).

- The companies are loaded at most once per 30 s per worker (`loadRecruiterCompanies`). That's every company of a CrankLeads org, plus house-org companies with `any_on`, active ones only. Reads page past the 1000-row cap.

### Tests

`src/test/staff-recruiter.test.ts` (fake DB, real services; Twilio, Resend and the model faked):

- Period maths, OT (44 h, straddling weeks), open and late-edited entries, the CSV, the summary cap.
- Settings defaults and house orgs, and registry wiring.
- **`payroll_period` end to end through `decideApproval`**: lock + email + text, the open-entry re-ask then "Y 2 anyway", N, expiry, a stale code, a bookkeeper email, an email failure.
- Unlock / lock / CSV download, and the settings view.
- The lock in `time/service.ts`, including the trigger error mapping.
- The human rights guard and pay checks.
- `start_hiring` (model draft stripped, template, withdraw, owner tool), and **`job_post` end to end** (publish + paste copy, N).
- Pages + apply (escaping, 404/410, hiring off, unpublished site, form checks, contact + paused AI, confirmation from the business number, repeat, existing customer, overnight → morning, opt-out).
- Screening (no PII to the model, redaction, fencing, protected-ground reason, rules fallback, once per applicant).
- Digest (08:30, cap 3, once a day), and **`interview_invite` end to end** (exact text, owner gets the reply, idempotent).
- Owner tools, the "anyway" parse, and the pages-host rewrite.

`src/test/recruiter-route.test.ts`: the settings route (member vs owner, strict PATCH), lock / unlock / CSV routes (roles, 404), and the public pages + apply POST (honeypot, too fast, rate limit, bad phone).

### Not yet

- No payroll provider API and no tax: the CSV is generic (no per-provider templates). Gross is an estimate.
- OT is the plain 44-hour weekly rule. Averaging agreements, exempt roles and public-holiday pay aren't modelled.
- Changing the frequency or anchor mid-period: the first new-schedule period that overlaps an old one is skipped (not asked), so those days are only in the old period.
- No "We're hiring" link on the generated home page yet; the jobs page is linked from the paste copy and Settings.
- No resume upload (the form asks for experience as text). Applicant contacts keep the default contact stage and aren't deleted when a job closes.
- The SMS agent recognises an existing customer who applied only from the conversation itself (prompt note). Applicant-only contacts are handled deterministically (AI paused).
