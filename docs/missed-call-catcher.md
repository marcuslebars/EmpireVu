# Missed-call catcher (no AI)

The CrankLeads **Catch** plan sells "missed-call text-back in seconds" **without** the AI
receptionist. The missed-call catcher is how that works for a business that keeps answering
its own phone.

## How it works

The business keeps its existing number. On their carrier they turn on **conditional call
forwarding** (no answer / busy / unreachable) to a CrankLeads Twilio number — the *catcher
number*. A call only reaches the catcher number when the business didn't pick up, so **every
call that arrives there is a missed call**.

```
Customer ──calls──▶ Business line ──(no answer / busy / off)──▶ Catcher number (Twilio)
                                                                     │
           POST /api/twilio/voice/inbound  ◀─────────────────────────┘
             1. verify X-Twilio-Signature (403 if bad)
             2. DURABLE: inbound_webhook_jobs (provider='twilio_voice', external_id=CallSid)
             3. tenant by the CALLED number → voice_numbers(provider='twilio', mode='missed_call_catcher')
             4. TwiML: "Sorry we missed your call — this is {company}. We'll text you right away.
                        Leave a message after the tone."  + <Record maxLength=120>
                                                                     │
  workflow-event worker (inbound-webhook queue) ── handleMissedCall ◀┘
             • missed_calls row (unique CallSid)
             • same lead intake as a form / Retell call → raw_leads + contact matched by phone
               (implied inquiry consent) + lead notification email + "New lead" push
             • emit call.missed → workflow_event_jobs → missed-call-text-back recipe
               → send_sms from the catcher number ("…{company} here…" + "Reply STOP to opt out")
             • same caller again within MISSED_CALL_TEXTBACK_WINDOW_MINUTES → call.missed is
               recorded emit-only (timeline, no second text, no second lead)

Caller leaves a voicemail ── POST /api/twilio/voice/recording?event=action|status|transcription
             • verify signature → DURABLE: inbound_webhook_jobs (provider='twilio_voicemail',
               external_id=recording:<RecordingSid> | transcription:<TranscriptionSid>)
             • worker handleVoicemail: missed_calls.recording_url (+ transcript),
               activity call.voicemail on the contact (push "Voicemail — …"),
               owner email with the link (+ transcript when MISSED_CALL_TRANSCRIBE=true)
```

- **Provider: Twilio.** It is already the SMS provider (`outbound/sms.ts`, `/api/twilio/sms/inbound`),
  so the same number takes the forwarded call **and** sends the text-back — the customer sees
  one number, and their reply comes back through the existing inbound-SMS handler (STOP etc.)
  to the right company. `deliverMessage` now sends from the company's own active Twilio
  number (catcher first) and falls back to `TWILIO_FROM_NUMBER` for companies without one.
- **The caller is `From`.** On a forwarded call Twilio keeps the original caller in `From`;
  the business line that forwarded it is in `ForwardedFrom` when the carrier passes it (stored
  on `missed_calls.forwarded_from`, shown in the lead message).
- **Same paths as the AI flow.** The lead goes through `handleLeadIntake` pinned to the tenant
  (exactly like `retell/lead-adapter.ts`), and `call.missed` is emitted through
  `emitActivityEventAndDispatch` → `workflow_event_jobs`, so the existing
  `missed-call-text-back` recipe runs unchanged.
- **Idempotent.** One queue job per CallSid / RecordingSid (unique `(provider, external_id)`),
  one `missed_calls` row per CallSid, one `call.missed` per CallSid (checked against
  `activity_events.metadata_json->>callId` before emitting), and a job retry never runs intake
  twice (the row's `lead_id` is set right after intake).
- **Never drops a lead.** The raw webhook is persisted before we answer Twilio. After that,
  failures are logged; a missing tenant or a not-yet-processed call throws so the queue retries
  with backoff and, if it keeps failing, dead-letters as `failed` (visible in Ops → jobs
  health; retry via `POST /api/organizations/{orgId}/inbound-webhook-jobs/{jobId}/retry`).
- **Withheld caller ID** (`anonymous`, `restricted`, Twilio's `+266696687` …): no lead and no
  text (nobody to text). A `call.missed` activity on the company tells the owner ("Missed call —
  caller ID withheld"); a voicemail still alerts.
- **Unknown number** (a Twilio number pointed at us with no catcher row): the job is stored,
  Twilio gets an empty `<Response/>` (call ends), and the worker job dead-letters with a clear
  "add a voice_numbers row" error.

### Throttle

The workflow engine does **not** throttle `send_sms` per recipient (the paid-action guard's
24-hour cooldown applies only to `call_lead` from unauthenticated sources). So the catcher
throttles at the source: a repeat call from the same number (last-10 match, same company)
within `MISSED_CALL_TEXTBACK_WINDOW_MINUTES` (default **10**; `0` disables) of a call that
**was** texted back is recorded on the timeline but not dispatched, and links to the earlier
lead instead of filing a new one. `missed_calls.text_back_status` records the decision:
`emitted | suppressed | anonymous`.

### Compliance (CASL / CRTC)

- The caller phoned the business → **implied consent** (inquiry), stamped by intake
  (`consent_source='implied_inquiry'`, `sms_consent_at`); valid 6 months.
- The recipe's first text identifies the business (`{{company.name}} here`), and
  `deliverMessage` appends **"Reply STOP to opt out"** to the first SMS to a contact.
- STOP / START replies to the catcher number go through the existing inbound-SMS handler
  (the catcher row is `provider='twilio'`, so the tenant resolves) and set `sms_opt_out_at`;
  every send re-checks consent, so an opted-out caller who calls again is **not** texted.
  See [messaging-compliance.md](messaging-compliance.md).

## Data

Migration `supabase/migrations/20261002130000_missed_call_catcher.sql` (rollback
`supabase/rollback/20261002130000_missed_call_catcher.down.sql`):

- `voice_numbers.provider` check now allows `'twilio'` (the inbound-SMS handler always looked
  for `provider='twilio'` rows, but the old constraint made them impossible to insert).
- `voice_numbers.mode` — `ai_receptionist` (default; Retell/Telnyx) | `missed_call_catcher` |
  `sms_only`. `voice_numbers.provider_number_sid` — the Twilio `PN…` sid.
- `missed_calls` — one row per caught call (contact link is the org-scoped composite FK
  `(contact_id, organization_id) → contacts(id, organization_id) on delete set null (contact_id)`,
  Postgres 15+): tenant, `call_sid` (unique), from/to/forwarded-from,
  contact + lead link, `text_back_status`, voicemail (`recording_sid`, `recording_url`,
  `recording_duration_seconds`, `voicemail_at`), transcription, `owner_alerted_at`,
  `raw_payload`. RLS on: members **select**; writes are service-role only (the worker).
- The contact page **Calls** tab (`listContactCalls`) now also lists caught calls, with the
  voicemail as the playable recording and the transcript.

### Number ownership (one Twilio account, many tenants)

All tenants share the platform's Twilio account, and inbound SMS/calls route by the
receiving number — so who may claim a number is a security boundary. Twilio
(`provider='twilio'`) `voice_numbers` rows are created **only** by provisioning; the manual
Settings → Voice numbers API accepts `retell`/`telnyx` only. Before any webhook is changed,
provisioning refuses a number when:

- it is the shared fallback sender `TWILIO_FROM_NUMBER` (E.164-normalised);
- it has a `voice_numbers` row in **any** org (active or not) that isn't this same company's
  Twilio row — checked with a service-role, cross-org lookup (`findVoiceNumberOwner`);
- its Twilio FriendlyName is `EmpireVu catcher <other companyId>`;
- (attach) it is untagged and already has a non-demo Voice/SMS webhook configured — clear it
  in the Twilio console first if it really is free.

Claimed numbers are tagged `EmpireVu catcher <companyId>`. DB backstop: `voice_numbers.phone_e164`
is globally `UNIQUE` (since `20260904180000`).

### Owner alerts

- **Push** on `call.missed` says "Text-back on its way" only when the company has an
  **active** `call.missed` workflow with a customer `send_sms` (`metadata.textBackActive`,
  set at emission); otherwise "New missed call from …".
- **Email** for a voicemail is sent **exactly once** (`missed_calls.owner_alerted_at` is
  claimed atomically before sending and released if the send throws). It links to the
  contact's page in the app (`{APP_BASE_URL}/crm/{contactId}`, Calls tab player) — **never**
  the raw Twilio recording URL, which is a bearer link (anyone holding it can listen; it is
  stored in `missed_calls.recording_url` for the in-app player only). It says "we already
  texted them back" only if an outbound SMS to the contact is actually in `message_log`.
- With `MISSED_CALL_TRANSCRIBE=true` and a recording ≤ 120 s (Twilio's transcription limit)
  the email waits for the transcript; a delayed fallback job (`inbound_webhook_jobs`
  `alert:<RecordingSid>`, +10 min) sends it if the transcript never comes. A transcript that
  arrives before its recording is retried. Longer recordings alert immediately.

## Setup (per client, ~5 minutes)

1. **Onboarding → Phone → "Missed-call catcher (no AI)"** (or `POST
   /api/organizations/{orgId}/missed-call-catcher` `{ companyId, areaCode: 705 }` /
   `{ companyId, attachNumber: "+1…" }`, owner/admin only). This:
   - buys a local number in the area code (country `TWILIO_NUMBER_COUNTRY`, default `CA`;
     voice + SMS capable), **or** attaches a number already in the Twilio account;
   - sets its **Voice URL** → `{base}/api/twilio/voice/inbound` and **Messaging URL** →
     `{base}/api/twilio/sms/inbound` (both `POST`), where `base` is `TWILIO_WEBHOOK_BASE_URL`
     or `APP_BASE_URL`;
   - stores it in `voice_numbers` (`provider='twilio'`, `mode='missed_call_catcher'`);
   - installs the `missed-call-text-back` recipe if the company doesn't have it (draft if SMS
     isn't configured).
   Re-running is safe: it re-checks the webhooks, never buys a second number, and a number
   bought on a run whose DB write failed is found again by its FriendlyName
   (`EmpireVu catcher <companyId>`).
2. **Owner turns on forwarding** from the business phone — the wizard shows these with the
   number filled in (`GET /api/organizations/{orgId}/missed-call-catcher?companyId=…`):

   | Condition | Turn on | Turn off |
   |---|---|---|
   | All conditional (recommended) | `**004*+1NUMBER#` | `##004#` |
   | No answer | `**61*+1NUMBER#` (or `**61*+1NUMBER**20#` to ring 20 s first; 5–30 s) | `##61#` |
   | Busy | `**67*+1NUMBER#` | `##67#` |
   | Unreachable (off / no signal) | `**62*+1NUMBER#` | `##62#` |

   **Landline / VoIP:** ask the phone provider (or use its portal) to set *call forward no
   answer* and *call forward busy* to the catcher number, ~4–5 rings. **Always verify with the
   carrier** — plans differ, and some carriers want 10/11 digits instead of `+1`. Never use
   *unconditional* forwarding (`**21*`) — the business phone would stop ringing.
3. **Test:** from a *different* phone, call the business number and let it ring out. The
   caller hears the greeting, the text arrives within seconds, and the wizard's test check
   completes when the `call.missed` lands in the activity feed.

   *Why no "Call me to test" button:* the test needs a call **to the business line from
   another phone** so the carrier's forwarding is exercised. A call placed by Twilio would
   arrive with the catcher number as caller ID and text the catcher itself — it would prove
   nothing about forwarding.

## Twilio console steps (once per deployment)

1. Use the account whose SID/token are in `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` (the
   same token verifies webhook signatures).
2. Make sure the account can buy **Canadian local numbers** (Phone Numbers → Regulatory
   Compliance; Canadian local numbers currently need no bundle, but check if a purchase is
   refused). US numbers would need A2P 10DLC registration for SMS.
3. *(Optional)* **Voice → Settings → "Enforce HTTP Auth on Media URLs"**: leave **off** so the
   owner can play voicemails from the link/Calls tab. If you turn it on, recordings need
   Twilio credentials to play (a proxy endpoint is not built yet).
4. *(Optional)* set a **Primary handler fails** fallback on the number (e.g. a TwiML Bin that
   says "Sorry we missed you, we'll call you back" and records) for the rare case the app is
   down.
5. *(Optional)* `MISSED_CALL_TRANSCRIBE=true` turns on Twilio's built-in transcription
   (English, ≤ 2 min, billed per minute by Twilio). Off by default.

## Env

| Var | Service | Default | Purpose |
|---|---|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | web, worker | — | Already required for SMS. Also: number provisioning (web) and webhook signature verification (web). |
| `TWILIO_FROM_NUMBER` | web, worker | — | Fallback sender for companies without their own Twilio number. |
| `APP_BASE_URL` | web, worker | — | Public origin; builds the webhook URLs and the signed-URL check. |
| `TWILIO_WEBHOOK_BASE_URL` | web | `APP_BASE_URL` | Override the origin Twilio calls (e.g. a separate API host). |
| `MISSED_CALL_TEXTBACK_WINDOW_MINUTES` | worker | `10` | Repeat-caller text-back suppression window (`0` = off). |
| `MISSED_CALL_VOICEMAIL_MAX_SECONDS` | web | `120` | Voicemail cap (5–600). |
| `MISSED_CALL_TRANSCRIBE` | web | off | `true` → Twilio transcription callback. |
| `TWILIO_SAY_VOICE` | web | `Polly.Joanna` | `<Say>` voice for the greeting. |
| `TWILIO_NUMBER_COUNTRY` | web | `CA` | Country catcher numbers are bought in. |

## Files

- `src/app/api/twilio/voice/inbound/route.ts`, `src/app/api/twilio/voice/recording/route.ts` — webhooks.
- `src/server/services/twilio/missed-call.ts` — tenant resolution + worker handlers (sanctioned service-role).
- `src/server/services/twilio/voice-twiml.ts` — TwiML (golden fixture `src/test/__fixtures__/missed-call-greeting.twiml.xml`).
- `src/server/services/twilio/provision.ts` — buy/attach + webhook config (mockable `TwilioNumbersClient`).
- `src/app/api/organizations/[organizationId]/missed-call-catcher/route.ts` — org API (GET members, POST admin).
- `src/lib/carrier-forwarding.ts` — forwarding codes/instructions (shared by UI + API).
- `src/components/onboarding/PhoneModeStep.tsx` — wizard Phone step choice + catcher setup + test check.
