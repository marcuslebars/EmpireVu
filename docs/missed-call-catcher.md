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
3. **Test — automatic.** Once the number exists, the Phone step (and, for a catcher-mode
   company, the wizard's *Test call* step) shows **Test my forwarding**. EmpireVu calls the
   business line, the owner lets it ring, and the result shows live in the wizard **and** is
   texted to the owner — see [Forwarding verification](#forwarding-verification) below.
   The manual test (call the business number from another phone and let it ring out) still
   works and is under "Prefer to test it yourself?".

## Forwarding verification

If the owner gets forwarding wrong, text-back silently never fires. So EmpireVu **proves**
forwarding works, on demand and on a schedule, and tells the owner without them watching.

```
"Test my forwarding" (owner/admin)                 worker scheduler (weekly / daily)
POST /api/organizations/{orgId}/missed-call-catcher/forwarding-test   processForwardingRetests
        └──────────────── placeForwardingTest ─────────────────────────────┘
   guards: Twilio configured · 08:00–21:00 company time · business line is +1, not premium,
   not one of OUR numbers · one in-flight test per number (partial unique index) ·
   owner tests: 1 per 2 min, 10 per 24 h per company (429)
   1. INSERT forwarding_tests (status='calling')            ← the callbacks find it by id
   2. Twilio Calls API: To=business line, From=caller ID, Timeout=40 s,
      StatusCallback + AsyncAmdStatusCallback → /api/twilio/voice/forwarding-test?testId=…&event=status|amd,
      Twiml (only if someone/voicemail answers): "This is an automatic test of your missed-call
      forwarding. Please don't answer it next time…"
        │ business line rings ~20–30 s, nobody answers → carrier conditional forwarding
        ▼
   Catcher number ── POST /api/twilio/voice/inbound (signature-verified, DURABLE job first)
        • From == test caller ID / business line, or ForwardedFrom == business line,
          within 3 min of an in-flight test of THIS company → <Response><Hangup/></Response>
          (no greeting, no voicemail)
        • worker handleMissedCall: recordForwardedLegIfTest → test PASSED; no missed_calls row,
          no lead, no call.missed, no text-back
   Final call status / AMD → /api/twilio/voice/forwarding-test (signature-verified, DURABLE:
        inbound_webhook_jobs provider='twilio_forwarding_test') → worker records it and, if the
        test is still in flight, schedules a finalize job 45 s later (a forwarded leg may still
        be queued) → outcome.
```

### Caller ID — why

The test call's caller ID is **`TWILIO_FORWARDING_TEST_FROM` when set** (a dedicated platform
"verifier" number in the same Twilio account), otherwise the **company's catcher number**.

- Both are numbers we own in the Twilio account, so Twilio allows them as caller ID and they get
  full STIR/SHAKEN attestation (a spoofed / unverified caller ID is what carriers block or label
  "Spam likely").
- The catcher number works with zero setup, and the owner recognises it ("we're calling you from
  your EmpireVu number"). Its one weakness: the forwarded leg arrives with `From == To` (the
  number calls itself via the carrier). We know of no carrier or Twilio rule that blocks that,
  but some PBX/VoIP forwarding loops treat "caller = forward target" as a loop.
- A dedicated verifier avoids that edge, is never a customer, and makes the forwarded leg
  unambiguous. **Recommended for production**: buy one number, set `TWILIO_FORWARDING_TEST_FROM`
  on **web + worker**, and point its Voice URL at a TwiML Bin that just says "This number is used
  for automatic forwarding checks" (owners sometimes call back a missed call). Never use a catcher
  number or `TWILIO_FROM_NUMBER` for it.

Detection does not depend on the carrier keeping the caller ID: a forwarded leg matches when
`From` is the caller ID **or** the business line (carriers that rewrite caller ID to the
forwarding line), **or** `ForwardedFrom` is the business line — and only within the test window
and only against that company's own tests (the tenant is already resolved from the CALLED
number). A real customer calling during a test has none of those fingerprints and gets the
normal greeting + text-back.

Self-call guard: a call to a catcher number **from** the catcher number or the verifier is never
treated as a customer (no lead, no text-back) — even outside any test window.

### Outcomes

| Outcome | When | `voice_numbers` |
|---|---|---|
| `passed` | the forwarded leg reached the catcher number (whatever the outbound leg reports — when forwarding works the outbound call is "answered" by our own catcher). Sticky: a late leg upgrades any other outcome. | `forwarding_verified_at = now` |
| `not_forwarded` | outbound `busy` / `no-answer`, or `completed` answered by a **machine** (AMD: the carrier's voicemail picked up before forwarding — the most common misconfiguration) | `forwarding_verified_at = null` |
| `answered` | outbound `completed`, answered by a person (or AMD unknown) — inconclusive | unchanged |
| `failed` | Twilio refused / `failed` / `canceled`, or no final status within 5 min (stale sweep) | `forwarding_verified_at = null` |

Every outcome sets `forwarding_last_test_at` and `forwarding_last_test_result`.
**Column contract (relied on by other features — don't rename):**
`voice_numbers.forwarding_verified_at timestamptz`, `voice_numbers.forwarding_last_test_at
timestamptz`, `voice_numbers.forwarding_last_test_result text` (`passed | answered |
not_forwarded | failed`).

**Passive proof:** a real customer call that the carrier forwarded **from the business line**
(`ForwardedFrom` present and equal to the business line, when we know it) also sets
`forwarding_verified_at`. A call dialled straight to the catcher number (e.g. a customer calling
back the text-back number) has no `ForwardedFrom` and proves nothing.

### Telling the owner

Through the existing owner plumbing (`resolveOwnerContacts` → `deliverMessage`, SMS from the
company's catcher number; email when there's no owner mobile), claimed once per result
(`forwarding_tests.notified_at`):

- passed — "✅ Missed-call text-back is live for {business}."
- not_forwarded — "{Heads up: }Missed-call text-back for {business} isn't working: our test call to
  {line} rang out / went to voicemail instead of forwarding. From that phone dial **004*{catcher}#
  and press Call. Test again: {APP_BASE_URL}/onboarding?step=phone"
- answered — "…was answered, so we couldn't check forwarding… Let it ring next time. Test again: …"
- failed — "We couldn't complete the forwarding test call to {line}… Check your business number in the app…"

Owner-triggered tests always notify. Scheduled retests notify only when a number becomes live
(passed, wasn't verified) and on every `not_forwarded` (broken after working, or the daily
nudge for a new number — capped by the schedule); scheduled `answered` / `failed` stay quiet
(visible in the app). The wizard polls `GET …/forwarding-test?companyId=` every 3 s while a test
is calling. `/onboarding?step=phone` deep-links to the Phone step.

**Onboarding:** the Phone step already completes when the catcher number is provisioned. A pass
completes the wizard's **Test call** step (`onboarding_progress` step `test_call`, data
`{ mode: 'missed_call_catcher', forwardingVerifiedAt, forwardingTestId }`) — only for a company
whose Phone step is in catcher mode, only if not already complete. For a catcher-mode company
the Test call step shows the forwarding test instead of "call Marina".

### Which number is called

Only the company's **own stored** number — never a request parameter: `companies.brand_reply_phone`
(the public business phone on quotes/branding), else `companies.owner_phone_e164` (Business step
"Owner phone"; for a CrankLeads buyer, the phone given at checkout — for most small trades that is
the business line). Must be +1 (NANP), not 900/976, and not the catcher, the verifier,
`TWILIO_FROM_NUMBER`, or any `voice_numbers` row in any org. If the owner's mobile is not the
line customers call, set the business phone in Settings → Company.

### Ongoing monitoring (worker scheduler)

`processForwardingRetests` runs inside the existing workflow-event worker's `runScheduler` pass
(once a minute, next to the owner digest) — no new Railway service:

- finishes tests stuck in `calling` > 5 min (no status callback) as `failed`;
- **verified** catcher numbers: re-test **weekly** (7 days since the last proof — a test or a
  real forwarded call);
- **unverified** numbers: **daily** for their first **14 days** (not in the first 2 h after the
  number is bought), at most **5** scheduled attempts; after that only the owner's button (and
  passive proof) — no endless calls;
- only **Mon–Fri 10:00–16:00 in the company's timezone** (`companies.timezone` →
  `BUSINESS_TIMEZONE` → America/Toronto), each number at its own stable minute in that window
  (spreads the calls), max 10 test calls per pass; the hard 08:00–21:00 guard applies too;
- needs `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` and `APP_BASE_URL` (or `TWILIO_WEBHOOK_BASE_URL`)
  on the **worker** — without them the pass does nothing.

### Data

Migration `supabase/migrations/20261004120000_forwarding_verification.sql` (rollback
`supabase/rollback/20261004120000_forwarding_verification.down.sql`): the three
`voice_numbers.forwarding_*` columns above, and `forwarding_tests` (org + company scoped,
composite company FK, RLS on, members **select**; writes are service-role only — a test places a
billed call, so it is only created through the rate-limited server path). One in-flight test per
number: unique partial index on `(voice_number_id) where status = 'calling'`.

### Not verified against live Twilio (check on first deploy)

- Carrier behaviour for a call whose caller ID equals the forward target (catcher-number caller
  ID) — use `TWILIO_FORWARDING_TEST_FROM` if tests come back `not_forwarded` while a manual test
  from another phone works.
- That `ForwardedFrom` is populated by Canadian carriers (detection doesn't need it; passive proof does).
- Async AMD accuracy on carrier voicemail greetings (an `unknown` result is reported as `answered`).

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
| `TWILIO_FORWARDING_TEST_FROM` | web, worker | catcher number | Optional platform verifier number used as caller ID for forwarding test calls (see "Caller ID — why"). |
| `TWILIO_WEBHOOK_BASE_URL` / `APP_BASE_URL` | **worker** too | — | The worker places scheduled test calls and builds their callback URLs. |

## Files

- `src/app/api/twilio/voice/inbound/route.ts`, `src/app/api/twilio/voice/recording/route.ts` — webhooks.
- `src/server/services/twilio/missed-call.ts` — tenant resolution + worker handlers (sanctioned service-role).
- `src/server/services/twilio/voice-twiml.ts` — TwiML (golden fixture `src/test/__fixtures__/missed-call-greeting.twiml.xml`).
- `src/server/services/twilio/provision.ts` — buy/attach + webhook config (mockable `TwilioNumbersClient`).
- `src/app/api/organizations/[organizationId]/missed-call-catcher/route.ts` — org API (GET members, POST admin).
- `src/lib/carrier-forwarding.ts` — forwarding codes/instructions (shared by UI + API).
- `src/components/onboarding/PhoneModeStep.tsx` — wizard Phone step choice + catcher setup + test check.
- `src/server/services/twilio/forwarding-test.ts` — forwarding verification service (sanctioned service-role): owner/scheduled tests, callbacks, outcomes, notifications, retest pass.
- `src/server/services/twilio/forwarding-test-logic.ts` — pure: outcome state machine, detection, rate limits, calling hours, retest selection, owner messages.
- `src/server/services/twilio/calls.ts` — Twilio Calls API client (mockable).
- `src/app/api/twilio/voice/forwarding-test/route.ts` — status + AMD callbacks (signature-verified, durable).
- `src/app/api/organizations/[organizationId]/missed-call-catcher/forwarding-test/route.ts` — GET status (members), POST "Test my forwarding" (owner/admin).
- `src/components/onboarding/ForwardingTestPanel.tsx` — the wizard panel (polls while calling).
