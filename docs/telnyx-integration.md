# Telnyx Voice AI Assistant → EmpireVu

EmpireVu exposes four endpoints that a Telnyx Voice AI Assistant (AI receptionist)
calls across a call's lifecycle.

## Endpoints

Paste these into the Telnyx portal (replace the host with your deployment):

| # | When | URL |
|---|---|---|
| 1 | Call start (greeting personalization) | `https://<host>/api/telnyx/dynamic-variables` |
| 2 | Mid-call pricing tool | `https://<host>/api/telnyx/tools/quote` |
| 3 | End of call (lead creation) | `https://<host>/api/telnyx/lead-intake` |
| 4 | Post-call Insights | `https://<host>/api/telnyx/insights` |

## Authentication

Telnyx does not HMAC-sign these requests, so all four are protected by a shared
secret header. Configure it on the Telnyx side for every endpoint:

```
x-empirevu-telnyx-secret: <value of TELNYX_WEBHOOK_SECRET>
```

Any request without an exactly matching header gets `401`. The comparison is
timing-safe and fails closed (a missing `TELNYX_WEBHOOK_SECRET` rejects everything).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TELNYX_WEBHOOK_SECRET` | yes | Shared secret for the `x-empirevu-telnyx-secret` header |
| `TELNYX_DEFAULT_TENANT_ID` | recommended | Company (brand) UUID used when the dialled number isn't in `telnyx_numbers` |
| `TELNYX_DEBUG_PAYLOADS` | no | `true` logs full raw payloads — use on first deploy to confirm field names, then turn off (payloads contain caller PII) |
| `TELNYX_DEPOSIT_CENTS` | no | Flat booking deposit in cents (default `10000` = $100) |
| `TELNYX_DEPOSIT_PERCENT` | no | Percentage deposit; takes precedence over the flat amount |
| `BUSINESS_TIMEZONE` | no | Returned as `system__timezone` (default `America/Toronto`) |

> The deposit is a **business rule, not pricing-engine output** — the engine has
> no deposit concept. It is configurable rather than hard-coded so it is never a
> number invented per call.

## Tenant resolution

**The number that was dialled decides the brand — never the request payload.**

Seed `telnyx_numbers` with one row per Telnyx number:

```sql
insert into public.telnyx_numbers
  (organization_id, company_id, phone_e164, source_site, brand_label)
values
  ('<org-uuid>', '<company-uuid>', '+19055550123', 'a1marinestorage', 'A1 Marine Storage');
```

`source_site` must be one of `a1marinecare`, `a1marinestorage`, `a1coatings` —
the same brand keys the existing web-form lead routing uses, so a phone lead
flows through the identical intake path. Unmapped numbers fall back to
`TELNYX_DEFAULT_TENANT_ID`.

---

## 1. `POST /api/telnyx/dynamic-variables`

Call-start customer lookup. **Telnyx times out at 1 second.**

This route is bounded by an internal **800 ms** budget and **never returns an
error status** — a timeout, malformed body, or database failure all return
`200` with fallback variables, because a failed lookup should cost a
personalized greeting, not the call. The only non-200 is `401`.

Response:

```json
{
  "dynamic_variables": {
    "customer_name": "Marcus",
    "smb__interaction_mode": "returning_customer",
    "system__timezone": "America/Toronto",
    "last_service_summary": "shrink wrap + winterization, Oct 2025"
  }
}
```

- `customer_name` — the contact's first name, or `"there"` when unmatched.
- `smb__interaction_mode` — `returning_customer` | `new_lead`.
- `last_service_summary` — **only present** when the caller has completed jobs.

Matching is a single indexed lookup on `contacts.phone_last10` (a generated
column mirroring the existing last-10 dedup rule), scoped to the dialled brand.

## 2. `POST /api/telnyx/tools/quote`

Mid-call pricing. Prices come from `@a1/pricing-engine` — **never computed here**.

Inputs (all read defensively; `boat_length_ft` accepts `24`, `"24"`, `"24 feet"`):
`service_type`, `boat_length_ft`, `boat_type`, `engine_type`, `engine_count`,
`tier`, plus `telnyx_conversation_id` and the called number.

Supported `service_type`: `shrink_wrap`, `outdoor_storage`, `winterization`,
`ceramic`, `detailing`.

**Success** — map these into dynamic variables in the Telnyx portal:

```json
{
  "status": "quoted",
  "quote_total": 432,
  "deposit_amount": 100,
  "currency": "CAD",
  "line_items": [{ "label": "Shrink wrapping", "amount": 432 }],
  "spoken_summary": "Shrink wrap for a 24-foot bowrider comes to $432, with a $100 deposit to book."
}
```

| Telnyx dynamic variable | Source field |
|---|---|
| `quote_total` | `quote_total` |
| `deposit_amount` | `deposit_amount` |

**Needs more info** — the assistant should ask for the field and retry:

```json
{ "status": "missing_info", "missing": ["boat_length_ft"] }
```

Missing-info is returned (rather than an error) whenever the engine needs an
input the caller hasn't given: `boat_length_ft` for per-foot services,
`engine_type` for winterization (it selects the flat rate), `tier` for detailing.

Every request — quoted, missing-info or unsupported — is logged to
`telnyx_quotes` as sales intelligence.

## 3. `POST /api/telnyx/lead-intake`

End-of-call lead creation. A **thin adapter only**: fields are mapped onto the
canonical lead envelope (`schemaVersion: 1`) and pushed through the existing
intake function, so dedup, brand routing, activity and notifications behave
exactly as they do for a web form.

Accepts: `name`, `phone`, `email`, `boat_length`, `boat_type`,
`services_selected`, `quote_total`, `deposit_amount`, `callback_preference`,
`notes`, `telnyx_conversation_id`, called number.

- Lead source is set to **`telnyx_voice_agent`**.
- `formType` is `quote` when a price was given, otherwise `contact`. It is never
  `booking` — a callback preference is not a scheduled datetime.
- Dedup is the existing normalized phone/email match, so a returning customer's
  call attaches to their record.
- **Idempotent** on `telnyx_conversation_id`: a retry returns the original lead.

```json
{ "data": { "status": "ok", "lead_id": "lead_ab12…", "duplicate": false } }
```

## 4. `POST /api/telnyx/insights`

Post-call analysis receiver. Upserts one row per conversation into
`telnyx_call_insights` keyed by `telnyx_conversation_id` (unique), which is the
**same row endpoint 3 stamped the `lead_id` on** — that's how an insight links to
its lead, and what makes retries idempotent.

The full payload is stored verbatim in `raw_payload`; typed columns
(`call_outcome`, `lead_quality`, `requested_service`, `booked`) are best-effort
reads because the upstream schema is unconfirmed.

---

## Tables

| Table | Purpose |
|---|---|
| `telnyx_numbers` | Dialled number → org + company + `source_site` |
| `telnyx_quotes` | Every quote request/response (amounts in **cents**) |
| `telnyx_call_insights` | One row per conversation: lead link + post-call analysis |

All three are readable by org members; **writes are service-role only** (the
Telnyx routes), mirroring `raw_leads`.

## First deploy

1. Apply the migration `20260720000000_add_telnyx_integration.sql`.
2. Set the env vars, with `TELNYX_DEBUG_PAYLOADS=true`.
3. Seed `telnyx_numbers`.
4. Place a test call, read the logged payloads, and confirm the field names the
   defensive parser probes (`payload.call.from`, `telnyx_end_user_target`, …).
5. **Turn `TELNYX_DEBUG_PAYLOADS` back off** — the payloads contain caller PII.
