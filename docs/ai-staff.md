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

## Dispatcher

## Marketer
