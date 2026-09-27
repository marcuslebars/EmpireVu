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
| `quote_shrink_wrap` | `POST /api/retell/functions/quote` | **Ready** (this PR) |
| Returning-caller lookup (inbound webhook) | `POST /api/retell/inbound` | **Ready** (this PR) |
| `check_availability` | `POST /api/retell/functions/availability` | Next PR (half-day booking windows) |
| `book_wrap_date` | `POST /api/retell/functions/book` | Next PR |
| `send_deposit_link` | `POST /api/retell/functions/deposit-link` | Next PR |
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

## Setup for A1 Marine Care (before cutover — safe to do now)

1. Apply `supabase/migrations/20260927120000_marina_phone_quote.sql` in the Supabase SQL editor.
2. Run `supabase/seeds/a1-care-shrink-wrap.sql` (re-runnable).
3. Confirm the Care company has a chargeable Stripe account (Settings → Payments), or deposits
   will fail at checkout once the deposit tool is live.
4. Add a `voice_numbers` row for Marina's Care number (Settings → Integrations → Voice numbers,
   provider `retell`, with the Care agent id) — this is what routes her calls to Care instead
   of the legacy Storage default. **Without it the quote tool refuses to price** (it will not
   quote Storage's $25/ft to a Care caller) and the inbound webhook greets neutrally.
5. Set the two greeting templates above on the Care voice profile to keep today's opener word
   for word.
6. Test without touching the live agent: duplicate the Care agent in Retell, point the copy's
   `quote_shrink_wrap` tool at `https://api.empirevu.com/api/retell/functions/quote` with the
   EmpireVu header, and call it on a spare number mapped in `voice_numbers`.

Cutover of the live agent waits until booking and deposits are here too (next PR) — moving
the quote tool alone would split one caller's quote and booking across two databases.
