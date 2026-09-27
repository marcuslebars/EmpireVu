# Marina's tools in EmpireVu

Marina (the Retell phone receptionist) used to get her *abilities* from the A1 Marine Care
website: quoting, booking, deposit links and the returning-caller greeting all ran on
`a1marinecare.ca/api/retell/*` against that site's own database. They now live in EmpireVu,
where they work for **any** company with a Marina number: the tenant is resolved from the
call itself (dialled number → Retell agent id), prices come from that company's catalog, and
everything lands in the same contacts, quotes and bookings as the rest of the app.

This is being moved in stages. **Nothing changes for callers until the Retell agent is
pointed here** (the cutover section at the end). Until then, the Care site keeps serving
Marina exactly as it does today.

| Tool | Endpoint | Status |
| --- | --- | --- |
| `quote_shrink_wrap` | `POST /api/retell/functions/quote` | **Ready** (PR 1a) |
| Returning-caller lookup (inbound webhook) | `POST /api/retell/inbound` | **Ready** (PR 1a) |
| `check_availability` | `POST /api/retell/functions/availability` | **Ready** (PR 1b) |
| `book_wrap_date` | `POST /api/retell/functions/book` | **Ready** (PR 1b) |
| `send_deposit_link` | `POST /api/retell/functions/deposit-link` | **Ready** (PR 1b) |
| Owner SMS per call, follow-up texts, speed-to-lead, 7am digest, health | — | PR 2 |

## Pricing parity

The Care site priced shrink wrap with its own calculator (`src/lib/shrink-wrap-pricing.ts`).
EmpireVu prices it from A1 Marine Care's service catalog, seeded by
[`supabase/seeds/a1-care-shrink-wrap.sql`](../supabase/seeds/a1-care-shrink-wrap.sql):

- shrink wrap $28/ft, $400 minimum, up to 40 ft (longer, or under 8 ft → the owner quotes it)
- pontoon +$16/ft, tritoon +$20/ft
- winterization per engine (outboard $275, sterndrive $400, inboard $445), extra engines at 75%
  **rounded to the cent** — the new `additional_unit_rounding = 'cent'` catalog option
- a **flat $250 deposit** — the new `companies.quote_deposit_flat_cents` policy

`src/test/marina-phone-quote.test.ts` runs 315 cases generated from the Care site's own
calculator through the seed and requires every subtotal to match to the cent. If you change a
rate, change the seed and regenerate the golden file together.

Two new platform features came out of this, both off by default so no existing tenant moves:

- **`service_catalog_items.additional_unit_rounding`** (`'dollar'` default | `'cent'`).
- **Fixed deposits**: `companies.quote_deposit_flat_cents` is the policy; each quote freezes
  the policy it was priced under in `quotes.deposit_flat_cents`, so a customer re-pricing
  optional lines on the hosted page (or a later policy change) can't move their deposit. The
  hosted page and the Stripe line say "comes off your final invoice" instead of a percentage.

## `POST /api/retell/functions/quote`

Header `x-empirevu-retell-secret: <RETELL_FUNCTION_SECRET>` (same secret as `capture-lead`).
**Payload: args only must be OFF** — the tenant and the caller's number come from Retell's
trusted `call` object, never from the model's arguments.

Arguments are **identical** to the Care site's `quote_shrink_wrap` schema, so the Retell tool
definition only needs its URL and header changed:

```json
{
  "name": "Caller's first and last name",
  "phone": "only if different from the number they're calling from",
  "email": "optional",
  "boat_length_ft": 24,
  "hull_type": "bowrider | cuddy | cruiser | pontoon | tritoon | sailboat | pwc | other",
  "winterization_engine": "outboard | sterndrive | inboard | none",
  "engine_count": 1,
  "boat_location": "driveway / trailer / storage lot / marina yard",
  "town": "Midland",
  "notes": "tower, arch, access…",
  "service": "optional catalog key; defaults to shrink_wrap"
}
```

What happens:

1. Tenant from the call (`voice_numbers` by dialled number, then agent id).
2. Missing name, length or phone → `{ ok:false, reason:"missing_info", missing:[…], say }`.
   Nothing is filed; Marina asks and calls again.
3. The phone lead is filed through the normal Retell intake (same dedup, same owner
   notification, same `retell_calls` row — idempotent on `call_id`, so the post-call webhook
   enriches it rather than creating a second lead).
4. Outside the auto-quote range → `reason:"manual_review"`; no catalog / unknown number →
   `reason:"unsupported"`. The lead is still filed in both cases.
5. Otherwise a real quote is created **and sent** (numbered, live at `/q/{token}`, emailed only
   if the caller gave an address): `{ ok:true, quote_id, quote_number, total_dollars,
   deposit_dollars, line_items, say }`. `total_dollars` is before HST, as Marina reads it.

Every response carries `say` — the sentence for Marina to read. Example:
*"The shrink wrap for a 24-foot bowrider comes to $672, and winterization is $481.25. That's
$1153.25 all in, plus HST. A $250 deposit holds your date and comes straight off that."*

## `POST /api/retell/inbound`

Retell's **inbound-call webhook**, set on the *phone number* (not the agent). Signed with the
API key like the post-call webhook. Answers within 1.5 s with the same dynamic variables the
Care site returned, so the agent prompt does not change:

`greeting`, `caller_known`, `caller_first_name`, `caller_boat`, `caller_services`, `quote_id`,
`quote_total`, `quote_age`, `booked_window`, `deposit_paid`, `deposit_link_sent`.

The lookup matches the caller's last 10 digits against **that company's** contacts only, then
their latest live quote (120 days) and next booking. Fail-open everywhere: a bad signature, the
flag off, an unmapped number or a slow database all answer as a new caller.

**Greeting.** Default: *"Thanks for calling {company}, this is Marina. How can I help you
today?"* / *"… Hi Dana — are you calling about the 24 ft bowrider?"*. Owners can override both
in the company's voice profile (`company_voice_profiles.dynamic_variables`):

| key | example |
| --- | --- |
| `greeting_new` | `Thanks for calling {{company_name}}, this is {{agent_name}}. Are you calling about shrink wrapping, or something else?` |
| `greeting_returning` | `Thanks for calling {{company_name}}, this is {{agent_name}}. Hi {{caller_first_name}} — are you calling about the {{caller_boat}}?` |
| `agent_name` | `Marina` |

## Booking by half-day window

A mobile crew books "Tuesday morning", not "10:00". That's a per-company **booking policy**
in `companies.booking_policy` (migration `20260928120000_marina_booking_windows.sql`). A
company without one keeps the hourly public-booking page exactly as before, and Marina's
booking tools answer "the owner will call to set the date".

```json
{
  "mode": "windows",
  "windows": [
    { "key": "morning",   "start": "09:00", "durationMinutes": 180, "spoken": "in the morning" },
    { "key": "afternoon", "start": "13:00", "durationMinutes": 180, "spoken": "in the afternoon" }
  ],
  "capacityPerWindow": 2,
  "leadTimeHours": 24,
  "horizonDays": 21,
  "workingDays": [1, 2, 3, 4, 5, 6]
}
```

Every field is optional after `mode` (defaults shown). A malformed policy is logged and
treated as the defaults: a typo in settings must not stop Marina booking.

- **Capacity counts every booking the crew has in that window**, not just Marina's. A job
  booked into the window counts, and so does a job added by hand in the app whose hours
  overlap the window. (The Care site only counted its own shrink-wrap bookings.)
- **Lead time works by date**, like the Care site: with 24 h notice, a call on Sunday afternoon
  can book Monday morning. A window that has already started is never offered.
- `src/test/marina-booking.test.ts` replays **280 availability cases generated from the
  Care site's own `findAvailableSlots`**, including the November DST change. Every one matches.

Bookings now carry `quote_id`, `window_key`, `source` (`marina`) and `source_call_id`.
`(quote_id, source_call_id)` is unique, so a retried tool call can never book the same caller
twice.

## `POST /api/retell/functions/availability`

Arguments: `preferred_date` (YYYY-MM-DD, optional) and `preferred_window` (`morning` /
`afternoon` / `am` / `pm`, optional). It returns up to three openings, nearest first, each with a
ready-to-read `label`, plus a `say` line: *"The next openings are Monday, September 28th in the
morning, or …"*. If the preferred window is open, it's first and `preferred_open: true`.

## `POST /api/retell/functions/book`

Arguments: `quote_id` (from the quote tool, or the returning-caller `quote_id` variable),
`date`, `window`. The quote must belong to the company the caller dialled. Otherwise the
tool answers `quote_not_found`, so a model can't book against another brand's quote. A full or
too-soon window comes back with up to three `alternatives`. On success it creates a
**pending** booking linked to the quote and the contact, and fires `booking.created`, which
drives the booking-reminder automation. Say: *"You're booked for Tuesday, September 29th in
the morning. We'll text to confirm the arrival time the day before."*

## `POST /api/retell/functions/deposit-link`

Arguments: `quote_id`, plus an optional `phone` / `email` if different from the quote's
contact. It texts the caller the quote's **hosted page** (`/q/{token}`), where they approve the
quote and pay the deposit on the company's own Stripe account:

> Hi Dana, it's Marina from A1 Marine Care. Here's your quote — $672 + HST. Tap to approve it
> and pay the $250 deposit that holds Tuesday, September 29 in the morning (it comes off your
> final invoice): https://…/q/…

- The text goes through the normal consent-checked messaging path (`message_log`, STOP footer
  on the first text, opt-outs honoured). If the text is blocked or fails, it falls back to email when there's
  an address.
- It records a `deposit_link_sent` quote event, which is what the returning-caller
  `deposit_link_sent` variable reads.
- If the deposit is already paid it says so and sends nothing. If the quote is draft,
  cancelled or expired, nothing is sent and Marina promises a manual follow-up.

**One behaviour change from the Care site.** There, the link went straight to a Stripe
checkout. Here it opens the quote first: one extra tap ("Approve"), but the customer sees the
line items and the company's terms before paying, and the approval is recorded. The link stays
valid for the life of the quote (30 days by default), not "the rest of the day". **Update
Marina's prompt**: remove "The deposit link is good for the rest of the day" (see cutover).

## Setup for A1 Marine Care (before cutover — safe to do now)

1. Apply `supabase/migrations/20260927120000_marina_phone_quote.sql` and
   `20260928120000_marina_booking_windows.sql` in the Supabase SQL editor.
2. Run `supabase/seeds/a1-care-shrink-wrap.sql` (re-runnable). It sets the catalog, the $250
   deposit and the half-day booking policy.
3. Confirm the Care company has a chargeable Stripe account (Settings → Payments), or deposits
   will fail at checkout once the deposit tool is live.
4. Add a `voice_numbers` row for Marina's Care number (Settings → Integrations → Voice numbers,
   provider `retell`, with the Care agent id) — this is what routes her calls to Care instead
   of the legacy Storage default. **Without it the quote tool refuses to price** (it will not
   quote Storage's $25/ft to a Care caller) and the inbound webhook greets neutrally.
5. Set the two greeting templates above on the Care voice profile to keep today's opener word
   for word.
6. Test without touching the live agent: duplicate the Care agent in Retell, point the copy's
   four tools at the EmpireVu URLs below with the `x-empirevu-retell-secret` header, set the copy's
   phone number's inbound webhook to `/api/retell/inbound`, map that number in `voice_numbers`,
   and call it from your own phone.

## Cutover (the live Care agent)

Do this when a test call on the duplicate agent has quoted, booked and texted a link that
you paid. Each step can be undone by putting the old value back.

1. **Carry over live bookings first** (PR 3: import the Care site's upcoming shrink-wrap
   bookings), so capacity already counts them. Until the Care site's own booking page books
   through EmpireVu too (PR 5), keep an eye on double bookings from the website.
2. In Retell, on the live Care agent, change each custom function:

   | Tool | New URL |
   | --- | --- |
   | `quote_shrink_wrap` | `https://api.empirevu.com/api/retell/functions/quote` |
   | `check_availability` | `https://api.empirevu.com/api/retell/functions/availability` |
   | `book_wrap_date` | `https://api.empirevu.com/api/retell/functions/book` |
   | `send_deposit_link` | `https://api.empirevu.com/api/retell/functions/deposit-link` |

   Replace the header `x-a1-retell-secret` with `x-empirevu-retell-secret: <RETELL_FUNCTION_SECRET>`
   (the EmpireVu value). Keep **Payload: args only** OFF.
3. Prompt edits (two lines):
   - In PRICING RULES, replace "The deposit link is good for the rest of the day — never quote any
     other window for it." with "The deposit link opens their quote; they approve it and pay there."
   - Step 6: replace "Tell them the link is good for the rest of the day" with "Tell them the link
     opens their quote to approve and pay".
4. Phone number → **Inbound webhook URL** = `https://api.empirevu.com/api/retell/inbound`.
5. Agent **Webhook URL**: leave it on the Care site for now. The Care site still sends the
   per-call owner texts and forwards to EmpireVu. PR 2 moves that and then this URL changes to
   `https://api.empirevu.com/api/retell/webhook`.
6. Publish the agent. Call the business line and run the go-live test.

To roll back, put the old URLs, header and prompt lines back and republish. The Care site's
endpoints stay live until PR 5 removes them.
