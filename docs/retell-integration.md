# Retell AI phone-lead intake

EmpireVu turns [Retell AI](https://retellai.com) voice-receptionist calls into leads. Retell
answers the phone, runs its post-call analysis, and POSTs a signed `call_analyzed` webhook to
EmpireVu, which maps the call onto the **same canonical lead envelope** every web form emits and
pushes it through the **identical** intake path — durable `raw_leads` write, cross-brand dedup,
activity, and owner notification. A phone lead is just another lead.

A1 Marine Storage is **tenant zero** (`sourceSite = a1marinestorage`), but everything is
org-scoped from day one, so adding more brands later is a config change, not a rewrite.

The whole feature is **inert unless `RETELL_INTAKE_ENABLED === "1"`**. With the flag off the
webhook still verifies the signature but ACKs without doing any work, so nothing runs until you
turn it on.

## Guarantees (why it's shaped this way)

- **Never drop a lead.** The raw call is written to `retell_calls` **first** (durable landing zone
  **and** the transcript store), then intake does its own durable `raw_leads` write. Both happen
  before any enrichment.
- **Idempotent.** `retell_calls.call_id` is `UNIQUE`. A Retell retry — or the `call_analyzed` that
  follows a mid-call capture — attaches to the existing row and never creates a second lead.
- **Signature-verified.** Every webhook is HMAC-checked before any work (see below). Fails closed.
- **PII stays in the database.** The transcript and analysis are written to `retell_calls`; they are
  **never** logged to stdout unless `RETELL_DEBUG_PAYLOADS=true` (off in production).
- **Server-only secrets.** Every credential is read from Railway env at runtime. Nothing is
  `VITE_`-prefixed; none of this module is importable from client code.

## Flow

```
Caller ──dials──▶ Retell agent ──────────────────────▶ EmpireVu (api.tilotto.com)
                    │  post-call analysis                POST /api/retell/webhook   (X-Retell-Signature)
                    └── call_analyzed webhook ──────────▶  1. verify HMAC · ACK fast · process async
                                                            2. retell_calls upsert   (durable + transcript)
                                                            3. build canonical phone-lead envelope
                                                            4. handleLeadIntake ─────▶ raw_leads · contact · activity · notify
                                                            5. link retell_calls → lead_id
   (optional, mid-call)
   agent calls capture_lead tool ──────────────────────▶ POST /api/retell/functions/capture-lead
                                                            same ingest, keyed by call_id (dedups vs. call_analyzed)
```

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/retell/webhook` | `X-Retell-Signature` HMAC | Receives `call_analyzed` (ignores other events). ACK-fast, async. |
| `POST /api/retell/functions/capture-lead` | `x-empirevu-retell-secret` header | Optional mid-call tool: capture a lead before the call ends. |

## Signature verification (reconciled)

Retell signs webhooks with your **Retell API key** — the key that shows a *webhook* badge in the
dashboard. **The signing secret IS the API key**; there is no separate "webhook secret" to generate.

- Header: `X-Retell-Signature: v={unix_ms_timestamp},d={hex_digest}`
- Digest: `HMAC-SHA256(apiKey, rawBody + timestamp)` — the **raw** request body concatenated with the
  timestamp from the `v=` field. Verify against the exact received bytes, never a re-serialized JSON
  string.
- Replay window: timestamps outside ~5 minutes are rejected (`RETELL_WEBHOOK_TOLERANCE_MS`).

`RETELL_WEBHOOK_SECRET` is accepted as an **alias/override** if you ever want a distinct value, but
normally you only set `RETELL_API_KEY`.

## Environment (Railway — EmpireVu web service)

Set these on the **EmpireVu** Railway service (the app that serves `api.tilotto.com`). **Never** on
the storage site, and **never** `VITE_`-prefixed.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `RETELL_INTAKE_ENABLED` | yes | `0` (off) | Master flag. Set to `1` to go live. |
| `RETELL_API_KEY` | yes | — | Retell API key; also the webhook signing secret. |
| `RETELL_WEBHOOK_SECRET` | no | falls back to `RETELL_API_KEY` | Only if you use a distinct signing value. |
| `RETELL_SOURCE_SITE` | no | `a1marinestorage` | Brand key intake routes on (tenant zero). |
| `RETELL_LEAD_SOURCE` | no | `retell_voice_agent` | Stamped on every phone lead's `source`. |
| `RETELL_FUNCTION_SECRET` | only for capture-lead | — | Shared secret for the mid-call tool. |
| `RETELL_WEBHOOK_TOLERANCE_MS` | no | `300000` | Replay window (5 min). |
| `RETELL_DEBUG_PAYLOADS` | no | `false` | `true` logs raw payloads (PII!) for schema discovery only. |

Reuses the existing `RESEND_API_KEY` / `LEAD_NOTIFY_EMAIL` for notifications — no new mail config.

## Retell dashboard: post-call analysis fields (**you must configure these**)

The lead fields are read from `call.call_analysis.custom_analysis_data`, which is populated by the
**Post-Call Analysis** schema you define on the agent in the Retell dashboard. Create these fields
with these **exact** names (a couple of aliases are also accepted, but prefer the primary name):

| Field name | Type | Maps to | Notes |
| --- | --- | --- | --- |
| `caller_name` | string | `contact.name` | |
| `caller_email` | string | `contact.email` | |
| `boat_make_model` | string | `asset.makeModel` | e.g. "2017 Sea Ray SPX 210" |
| `boat_length_ft` | number | `asset.lengthFt` | "24", "24 feet" both parse |
| `boat_type` | string | `asset.type` | pontoon / bowrider / … |
| `engine_type` | string | `asset.engineType` | outboard / sterndrive (I/O) / inboard |
| `engine_count` | number | `asset.engineCount` | "twin" / "single" also parse |
| `boat_location` | string | `asset.location` | town / marina where the boat is |
| `on_trailer` | boolean | `asset.onTrailer` | |
| `services_requested` | string[] | `services` | list, or a comma-joined string |
| **`is_urgent`** | boolean | `meta.urgent` | **the urgency flag — see below** |

The caller's phone number comes from `call.from_number` automatically (no analysis field needed).
Anything the analysis omits is simply left off the lead — intake never rejects an incomplete call;
it stores it and flags it for attention.

### Urgency escalation

Define **`is_urgent`** (boolean) in the post-call analysis, with a prompt like *"true if the caller
needs service urgently or before a hard deadline (e.g. first freeze), otherwise false"*. When it is
true:

- the lead's notification email is prefixed **🚨 URGENT** (subject + body callback line), and
- `raw_leads.needs_attention` stays **true** even on a clean parse, so the lead sits in the
  needs-attention queue for an immediate callback.

(A dedicated SMS/Slack escalation channel is a future enhancement; today the urgent-marked email +
attention flag is the escalation.)

## Webhook + function configuration in Retell

1. **Webhook URL** → `https://api.tilotto.com/api/retell/webhook`. Enable the `call_analyzed` event
   (others are harmlessly ignored). Retell signs it with the API key automatically.
2. **(Optional) capture-lead tool** → add a custom function named `capture_lead` pointing at
   `https://api.tilotto.com/api/retell/functions/capture-lead`, sending the header
   `x-empirevu-retell-secret: <RETELL_FUNCTION_SECRET>`, with arguments mirroring the field names
   above. The agent calls it once it has the caller's number + a service interest.

## Apply the migration

`retell_calls` ships in `supabase/migrations/20260811000000_add_retell_integration.sql`. Railway does
**not** run migrations — apply it manually in the Supabase SQL editor (same as every other migration),
then it's live. RLS: org members read; only the service role (this webhook) writes.

## Go-live checklist

1. Apply the migration in Supabase.
2. Set `RETELL_API_KEY` (+ `RETELL_FUNCTION_SECRET` if using the mid-call tool) on the EmpireVu
   Railway service.
3. Configure the post-call analysis fields + webhook URL in the Retell dashboard.
4. Flip `RETELL_INTAKE_ENABLED=1` and redeploy.
5. Place a test call; confirm the lead appears (and the 🚨 URGENT email if you flagged it urgent).

## Outbound calling (Marina) — replacing Cartesia

Retell also places **outbound** calls (the "Marina" agent), replacing the Cartesia
`placeOutboundCall` path. All three call sites — the CRM "Call" action, the top-bar Quick Call, and
the `call_lead` workflow action — go through `services/voice.ts`, which picks the provider:

- **Retell** when `RETELL_OUTBOUND_ENABLED=1` **and** the outbound config is present, otherwise
- **Cartesia** (fallback), so nothing breaks mid-migration.

When Retell places a call it passes:

- `metadata: { contactId, organizationId, companyId }` — echoed back on the call object, so the
  `call_analyzed` webhook can attach the outcome to the right contact.
- `retell_llm_dynamic_variables: { customer_name, company_name }` — **the fix for the old "greets
  wrong company" bug.** Your outbound agent's prompt must reference `{{company_name}}` and
  `{{customer_name}}` in its greeting.

### The webhook behaves differently by direction

The same `/api/retell/webhook` handles both directions and branches on `call.direction`:

- **`outbound`** → logs a `contact.call_completed` activity on the contact (summary, sentiment,
  voicemail, status). **Never creates a lead.** Gated by `RETELL_OUTBOUND_ENABLED`.
- **`inbound`** → the phone-lead intake above. Gated by `RETELL_INTAKE_ENABLED`.

Outbound outcomes arrive by **webhook push** — no polling. The Cartesia outcome poll skips Retell
calls (tagged `provider: "retell"` on the placed-call event).

### Env (EmpireVu Railway service)

| Variable | Required | Notes |
| --- | --- | --- |
| `RETELL_OUTBOUND_ENABLED` | to switch on | `1` routes outbound calls through Retell; else Cartesia. |
| `RETELL_API_KEY` | yes | Same key as inbound. |
| `RETELL_FROM_NUMBER` | yes | The Retell number to dial FROM (E.164). |
| `RETELL_OUTBOUND_AGENT_ID` | recommended | A dedicated outbound agent (its own dial-out greeting). If unset, the from-number's default agent is used. |

### Configure + go live

1. Import/assign a Retell phone number to dial from → set `RETELL_FROM_NUMBER`.
2. Build an **outbound agent** whose greeting uses `{{company_name}}` / `{{customer_name}}`; put its id in `RETELL_OUTBOUND_AGENT_ID`. Point it at the same `/api/retell/webhook` (`call_analyzed`).
3. Flip `RETELL_OUTBOUND_ENABLED=1` and redeploy. Place a test call from the CRM; confirm a `contact.call_completed` lands on the contact (and NO new lead).

### Fully retiring Cartesia (later)

Once Retell outbound is proven: leave the flag on, then delete the Cartesia branch in
`services/voice.ts` + `outbound/voice.ts` and the `CARTESIA_*` env. Until then Cartesia stays as an
automatic fallback.

## Local dev: simulate a signed webhook

`scripts/dev/retell-simulate.ts` builds a `call_analyzed` payload, signs it exactly as Retell does,
and (a) verifies the signature and (b) runs it through the field-reader → envelope → schema pipeline,
printing the resulting canonical lead. No database required — it proves the transform end-to-end.

```bash
npx tsx scripts/dev/retell-simulate.ts
```

To exercise the full DB write, run the app locally with Supabase creds + `RETELL_INTAKE_ENABLED=1`
and POST the signed body to `/api/retell/webhook`.
