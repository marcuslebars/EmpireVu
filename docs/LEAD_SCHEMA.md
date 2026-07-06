# EmpireVu Lead Envelope — schemaVersion 1

This is the **contract** every lead source (spoke) emits and the EmpireVu intake endpoint accepts. It is what the winter **Jobber** adapter will be written against, once, and what the future **A1 Coatings** spoke implements. Keep it stable; version it (`schemaVersion`) rather than mutating it.

## Endpoint

```
POST /api/intake
Content-Type: application/json
X-EmpireVu-Signature: sha256=<hex HMAC-SHA256 of the raw request body, keyed by LEAD_INTAKE_SECRET>
```

- **Auth is HMAC**, not a bare shared secret: the spoke signs the exact bytes it sends. A missing/invalid signature → `401` (this is the only rejection the endpoint makes).
- **A valid signature is never rejected for schema reasons** (see *Never drop a lead*).
- The endpoint is **not** subject to session auth (the middleware matcher excludes `/api/*`).

## Envelope

```jsonc
{
  "schemaVersion": 1,                     // required, literal 1

  "source":      "a1marinestorage-contact", // required — brand-form tag (freeform, e.g. "<brand>-<form>")
  "sourceSite":  "a1marinestorage",         // REQUIRED — brand id; routes the lead to a company. (Fix for the
                                            //   pre-existing defect where Care quote/booking carried no brand tag.)
  "formType":    "contact",                 // required — one of: "quote" | "contact" | "booking"
  "receivedAt":  "2026-07-06T14:03:00.000Z",// required — ISO 8601; the spoke's capture time

  "contact": {                              // required object; AT LEAST ONE of email/phone must be present
    "name":  "Jane Boater",                 // optional
    "email": "jane@example.com",            // optional (but email OR phone required)
    "phone": "+1 705-555-0101"              // optional (but email OR phone required)
  },

  "message": "Looking to winterize a 24ft bowrider.", // optional — SINGLE normalized free-text field
                                            //   (reconciles the spokes' inconsistent message vs notes split)

  "lineItems": [                            // optional — Jobber-shaped; preserved end-to-end for the winter adapter
    { "description": "Shrink Wrap (24ft)", "quantity": 1, "unitPriceCents": 41400 }
  ],

  "asset": {                                // optional — boat/asset block; normalizes the 3 spoke field variants
    "makeModel": "2018 Sea Ray 240",        //   (was boatName / boatMakeModel / boatMakeModelYear)
    "lengthFt":  24,                        //   integer feet
    "type":      "bowrider",                //   (was boatType / hullType)
    "marina":    "Queen's Cove"             //   marina / location
  },

  "meta": {                                 // optional — capture context
    "site":          "a1marinestorage.ca",
    "page":          "/calculator",
    "preferredDate": "2026-10-15",          // booking forms only; drives the bookings row for formType=booking
    "preferredTime": "09:00",               // booking forms only
    "utm": { "utm_source": "google", "utm_campaign": "fall-storage" }
  }
}
```

### Field rules

| Field | Required | Notes |
|---|---|---|
| `schemaVersion` | ✓ | Must be `1`. Unknown versions are accepted but stored raw + flagged. |
| `source` | ✓ | Brand-form tag; used in the notification subject and stored for reporting. |
| `sourceSite` | ✓ | **Brand id** — the routing key to a company. Required so no lead is company-ambiguous. |
| `formType` | ✓ | `quote` \| `contact` \| `booking`. |
| `receivedAt` | ✓ | ISO 8601. EmpireVu also stamps its own server receive time. |
| `contact` | ✓ | Object; **email or phone required** (name alone is not enough to be a lead). |
| `message` | — | Single free-text field. Spokes must fold their `message`/`notes` into this one. |
| `lineItems[]` | — | `{description, quantity, unitPriceCents}` — integer cents. |
| `asset` | — | `{makeModel?, lengthFt?, type?, marina?}`. |
| `meta` | — | `{site?, page?, preferredDate?, preferredTime?, utm?}`. |

### Reconciled spoke deviations (from the Phase 0 audit)

- **`sourceSite` is now required** — Care quote/booking previously sent no brand tag, making Care and Storage quotes indistinguishable. The shared spoke pipeline sets it for every send.
- **One free-text field (`message`)** — replaces the `message` vs `notes` inconsistency.
- **No duplicate `site`/`sourceSite`** — the storage payload's redundant `site` is dropped; brand lives only in `sourceSite`, capture host in `meta.site`.
- **One boat/asset shape** — `asset.makeModel` / `asset.type` normalize `boatName`/`boatMakeModel`/`boatMakeModelYear` and `boatType`/`hullType`.

## Never drop a lead

The intake **always returns `200 {"ok":true,"leadId":"..."}`** to an authenticated caller, and the durable write happens **before** any notification or matching:

1. **Every** request (valid or not) is written to `raw_leads` first, with the full raw payload and a `schema_valid` flag.
2. **Valid** envelopes are additionally parsed into a **contact** (matched or created) + an **activity_event** (+ a **booking** when `formType=booking` and `meta.preferredDate` is a parseable date).
3. **Invalid / unknown** payloads (bad schema, unknown `schemaVersion`, no contact method) are kept as `raw_leads` with `schema_valid=false`, still trigger a notification **marked "needs attention"**, and still return `200`.
4. **Matching and notification failures degrade** — they are caught and logged; the durable write already succeeded, so the request still returns `200`.

Validation sorts; it never gatekeeps. A malformed lead is still a customer.

## Mapping to the EmpireVu schema

| Envelope | EmpireVu |
|---|---|
| `sourceSite` | resolves the **company** (by `companies.slug`/brand map) within the A1 org; unresolved → `raw_leads` with null company, flagged |
| `contact` (email/phone normalized) | **match or create** `contacts` under that company (see *Matching*) |
| `source`, `sourceSite`, `formType`, `asset`, `meta` | `contacts.metadata` + `activity_events.metadata_json` |
| `message` | `contacts.notes` (on create) + activity metadata |
| `formType` | an `activity_events` row, `event_type = "lead.<formType>"` (`lead.contact` \| `lead.quote` \| `lead.booking`) |
| `formType=booking` + `meta.preferredDate` | a `bookings` row (`scheduled_for` from preferredDate) |
| `lineItems[]` | `activity_events.metadata_json.lineItems` (Jobber-shaped, preserved) |
| raw payload + `schemaValid` + generated `leadId` | `raw_leads` |

## Customer matching (Phase 3 backbone; Jobber consumes it in winter)

On each valid lead, before creating a new contact:

- Normalize **email** (lowercase, trim) and **phone** (digits only, compare last 10).
- Look for an existing contact in the **org** matching **either** normalized key.
- **Match** → link the lead to that contact (no duplicate), record a cross-company `activity_event`, and flag **returning / cross-brand** in the notification (a storage quote from a past Marine Care contact is the headline case).
- **No match** → create the contact under the `sourceSite`'s company.
- Matching is **enrichment only** — if it errors, log and record the lead unenriched. It never blocks or delays the durable write.

**Winter Jobber adapter** is expected to use this contact record as the unified customer seed: on export, **match → existing Jobber client**; **no match → create a Jobber client**. The `contacts` normalized keys (email + last-10 phone) are the join key.

## Versioning

Bump `schemaVersion` for breaking changes; the intake keeps accepting older versions (older payloads are still valid envelopes). Never repurpose a field's meaning within a version.
