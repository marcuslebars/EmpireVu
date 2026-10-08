# Done-for-you CrankLeads

## Automatic switch-on

A CrankLeads buyer never works through a wizard. After they pay we buy their number, switch
everything on as soon as we know enough about the business, text them ONE link that turns on
call forwarding, test it ourselves, and tell them "You're live". If they aren't live 24 hours
after buying, an operator gets a task to call them.

### What happens, in order

| When | What | Where |
| --- | --- | --- |
| Purchase provisioned (billing worker) | Buy the tier's number right after the company exists: **Catch / Close** → the missed-call text-back (Twilio catcher) number; **Front Desk** → the AI receptionist's (Retell) number. Area code = the checkout phone's NPA (fallback 705; then any). Never fails provisioning — a failure is recorded and retried. | `crankleads/provision.ts` step 6b → `dfy/numbers.ts` `ensureDfyNumber` |
| Every minute (worker scheduler, `runDoneForYouSweep`) | `processDoneForYou` advances up to 25 provisioned, not-live CrankLeads companies (least recently advanced first, purchases from the last 30 days). | `dfy/orchestrator.ts` |
| Number missing | Retry with backoff (1 min, 5 min, 20 min, 1 h; own area code ×2, then 705, then any). After 5 failed attempts: `number_flagged_at` + one operator email; shows in the daily health email. | `ensureDfyNumber` |
| `setup_intakes.status = 'enriched'` — or the intake is ≥ 2 h old and unanswered, or stuck in submitted/enriching ≥ 6 h, or there is no intake row and the purchase is ≥ 2 h old | **Switch on, once** (`switched_on_at`, details in `switch_on_detail`): install + activate the tier's automations (drafts only; a channel that isn't configured keeps it draft; paused ones are never touched); review requests on when `brand_review_url` exists and the owner never chose; online-booking hours from `companies.hours` while the booking hours are still the defaults; Front Desk: rebuild the AI receptionist prompt (hours, service area, services with any prices) and re-push it to Retell — an update of the same LLM/agent/number, never a new purchase. | `dfy/switch-on.ts` |
| Switched on + number bought + not verified, 08:00–21:00 company time | **Forwarding text + email, once** (`forward_text_sent_at`), from the platform sender (`TWILIO_FROM_NUMBER`), with the no-login link `/forward/<token>`. | `sendForwardingLink` |
| Owner taps (Android) / confirms (iPhone, landline) | `forward_tapped_at`. ~45 s later (next page poll or sweep) ONE automatic forwarding test via the existing owner-test path (rate-limited, 08:00–21:00, the company's own business line). Each new tap allows another (max 5); the existing daily/weekly re-tests carry on. Catcher path only — see Front Desk below. | `dfy/forwarding.ts` |
| Not live at purchase + 24 h, moved into operator hours (Mon–Fri 08–18, `BUSINESS_TIMEZONE`) | **Escalation, once** (`escalated_at`): email to `OWNER_EMAIL` — "Call <name> <phone> to finish setup — <business>" with what's done / left and `${APP_BASE_URL}/concierge/<organizationId>`. Also listed in the daily operator health email ("Finish setup for them (concierge)"). | orchestrator step 5, `operator-health/*` |
| "Have us set it up — we'll call you" on the forwarding page | `forward_help_requested_at` + one operator email (same format, with the line kind/carrier). Listed in the daily health email. | `forwardingHelpHandler` |
| Checklist first reports live | `crankleads_purchases.live_at` + ONE "You're live" text + email (08:00–21:00): what now works, their number, their page (`company_sites` published → `companySiteUrl(slug)`), a login link (the email carries a one-time set-password link if they never signed in — buyer's checkout email only; the text never does). | `crankleads/setup-followups.ts` |

### "Live" (new definition — `crankleads/setup-checklist.ts`)

- **Catch / Close** (and Front Desk that chose the catcher): text-back number active **+** forwarding verified (`voice_numbers.forwarding_verified_at`: a passing test or a real forwarded call) **+** the missed-call text-back automation active.
- **Front Desk**: AI number active **+** forwarding verified on that number **or** a real call has reached the AI receptionist (`retell_calls`).
- Prices, payments (Stripe), the website form, the team and the test call are **not** required. They are `extras` on the checklist (shown in the app as "Optional"), never chased. Nothing asks for Stripe: an owner meets the existing "connect Stripe" explanation the first time they try a deposit or card payment.

Everything reading the checklist follows: the follow-ups, the operator health email (setup stalled / guarantee), the dashboard card, the onboarding API.

### Follow-ups (rewritten)

Same schedule (business day 1/3/5/10, 09–18 company time, one per day, stop link), but each reminder asks for exactly ONE thing with ONE no-login link: the 60-second quick setup (`/setup/<token>` while `setup_intakes.status` is pending/sent/opened) or else the forwarding tap (`/forward/<token>`). No wizard steps, no Stripe, no set-password link. The day-10 operator "stuck" email is gone — the 24 h escalation replaces it.

### In the app

CrankLeads orgs see **"We're setting you up"** at `/onboarding` instead of the 8-step wizard, and a small card on the dashboard instead of "Finish setting up": ✓ number bought, ✓ business details found, ✓ automations on, ✓ your page is live (only when a `company_sites` row exists), the one thing left (turn on forwarding → the same one-tap page), and optional extras (add prices, connect payments). Data: `GET /api/organizations/{orgId}/setup-progress` (`dfy/progress-view.ts`). Non-CrankLeads orgs keep the wizard.

### The one-tap forwarding page (`/forward/:token`)

Public, no login; the 32-char `dfy_progress.forward_token` is the credential (rate-limited, `noindex`, returns only the business name, the number to forward to, the code and the verification state). API: `GET/POST /api/public/forward/{token}` (`POST {action: "opened" | "tapped" | "help"}`; GET never changes state except starting the one auto-test after a tap, which a link scanner can't do).

- **Android / other phones**: one big button = `tel:` link with the code, `#` encoded as `%23` (an unencoded `#` is a URL fragment and gets dropped). The dialler opens with the code; they press Call.
- **iPhone**: iOS refuses to dial `tel:` links containing `*` or `#` (Apple's documented tel-scheme restriction), so: big **Copy code** button + "Open the Phone app → Keypad, touch and hold, Paste, Call" + **I've done it — test it for me**. There is no web link that opens the iOS keypad without dialling a number, so there is no "Open Phone" button (it would either do nothing or call the wrong thing).
- **Landline / VoIP**: no codes. Exact words to ask the provider (named when we know it: Bell, Rogers, TELUS, Videotron, Cogeco, Shaw, Eastlink, Vonage, Ooma, RingCentral, Fongo), the number with a Copy button, **Have us set it up** (operator call) and **I've set it up — test it for me**.
- "Code didn't work?" shows the individual codes (`**61*`, `**67*`, `**62*`), the provider script and the help button.

### Carrier codes — what we're sure of and what needs a real phone

All cell plans use the 3GPP (GSM/LTE) MMI codes, dialled from the business phone itself:
`**004*+1NNNNNNNNNN#` = forward when busy, unanswered and unreachable (all conditional), off with `##004#`. Fallbacks: `**61*…#` no answer, `**67*…#` busy, `**62*…#` unreachable (off: `##61#`, `##67#`, `##62#`). We never use unconditional forwarding (`**21*`).

| Carrier (key in `business_phone_carrier`) | Network | Confidence | Notes |
| --- | --- | --- | --- |
| Rogers (`rogers`), Fido (`fido`), chatr (`chatr`) | Rogers | **confident** | Standard GSM codes, long supported. |
| Freedom Mobile (`freedom`) | Freedom | **confident** | GSM network; standard codes. |
| TELUS (`telus`), Koodo (`koodo`), Public Mobile (`public`) | TELUS | **verify** | Third-party guides for TELUS mobile list `*61*` / `*67*` conditional codes; `**004*` expected to work on its LTE/5G network but not yet confirmed on a real phone. Some prepaid plans may lack forwarding. |
| Bell (`bell`), Virgin Plus (`virgin`), Lucky Mobile (`lucky`) | Bell | **verify** | Expected to accept the standard codes on LTE/5G; not yet confirmed. |
| Videotron (`videotron`) | Videotron | **verify** | Not yet confirmed. |
| anything else / unknown carrier, or kind unknown | — | **verify** | Same code; the provider script is always one tap away. |
| any landline / VoIP | — | n/a | Provider sets "call forward no answer" + "call forward busy" (4–5 rings). We don't publish star codes for landlines: they vary by provider and by whether the feature is on the line. |

Before relying on a "verify" row: on a real phone on that carrier, dial the code, call the business line from another phone without answering, confirm the text-back arrives, then `##004#`. Update `CELL_CARRIERS` in `src/lib/carrier-forwarding.ts` (and this table) when confirmed. The automatic test after the tap catches a code that silently didn't take (`not_forwarded` → the page and the owner text say so).

### Front Desk

Forwarded calls go to the Retell number, which our Twilio forwarding test can't observe, so Front Desk is verified by the first call that reaches the AI receptionist (the page tells the owner to call their business line from another phone and let it ring). No automatic test call is placed for Front Desk.

### Data

Migration `20261008120000_dfy_autolive.sql` (rollback `supabase/rollback/20261008120000_dfy_autolive.down.sql`): `dfy_progress` (one row per company; RLS: members select; service role writes only) — `number_attempts`, `number_last_attempt_at`, `number_last_error`, `number_ready_at`, `number_flagged_at`, `switched_on_at`, `switch_on_detail`, `forward_token` (unique), `forward_text_sent_at`, `forward_opened_at`, `forward_tapped_at`, `forward_help_requested_at`, `forward_tests_started`, `forward_last_test_at`, `escalated_at`, `last_run_at`, `last_error`. Operator fix for a flagged number: clear `number_flagged_at` and set `number_attempts = 0` (the sweep retries), or buy it from the concierge console.

Reads (owned by other parts): `setup_intakes` (status, token), `company_sites` (status, slug), `companies.hours / business_phone_kind / business_phone_carrier / brand_review_url`.

### Env

No new required variables. Uses `APP_BASE_URL` (operator links, Twilio webhooks), `CRANKLEADS_APP_BASE_URL` (buyer links), `OWNER_EMAIL` (operator emails), `BUSINESS_TIMEZONE` (escalation hours), `TWILIO_*` / `RETELL_API_KEY` (numbers, texts, tests), `RESEND_API_KEY` / `OUTBOUND_FROM_EMAIL`. Optional `COMPANY_SITE_BASE_URL` — base of the generated-site URL in the "You're live" message (default `<CrankLeads app>/s`; must match the site builder's public route).
