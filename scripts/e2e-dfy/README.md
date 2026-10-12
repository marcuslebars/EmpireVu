# Done-for-you end-to-end harness

Proves the done-for-you CrankLeads flow (docs/done-for-you.md) the way a buyer lives it, against a
**real local database**, with only third parties faked. Never point it at production.

```sh
scripts/e2e-dfy/run.sh            # start everything, run the flow, print the timelines (exit 0 = all pass)
scripts/e2e-dfy/stop.sh           # stop the stack
E2E_SHOTS=/some/dir scripts/e2e-dfy/run.sh   # where screenshots go (default /var/tmp/e2e-dfy/shots)
E2E_SKIP_START=1 scripts/e2e-dfy/run.sh      # re-run the driver against a running stack (fresh DB needs start.sh)
```

## What runs

| Piece | File | Notes |
| --- | --- | --- |
| Postgres 16 | `setup-db.sh` | `/var/tmp/e2epg`, port 55434, socket `/var/tmp/e2esock`. Fresh DB every start: `scripts/sql-tests/supabase-stubs.sql` + every migration + `e2e-extras.sql` (auth columns, `authenticator` role). DB timezone UTC like Supabase. |
| PostgREST 12 | `start.sh` | `postgrest` on PATH, else `/var/tmp/pgrst-dl/postgrest` (static binary from the GitHub release). |
| Gateway | `gateway.mjs` | The one origin (`:55439`): `/rest/v1` → PostgREST, `/auth/v1` → a stub of Supabase Auth backed by `auth.users` (admin users list/get/create/update, `generate_link`, `user`, password/refresh `token`), `/api`, `/s`, `/r`, `/_next` → Next dev, everything else → Vite dev. Any user signs in with password `e2e-password-123`. |
| Fakes | `fakes.mjs` | Twilio (numbers by area code, SMS, calls), Resend, Retell, Google Places (Northshore Snow & Lawn, Midland ON, 4.8★/37), Anthropic (catalog parse + site copy, built only from the text/facts it is sent), and the buyer's website `northshoresnow.ca` (4 pages, ONE stated price, a logo). Every SMS / email / call / purchase goes to `$E2E_CAPTURE_LOG` (JSONL). |
| fetch redirect | `intercept.cjs` | Preloaded into Next and the driver (`NODE_OPTIONS=--require`): rewrites fetch() to the hosts above to the fakes server; DNS for the fake website resolves to a public TEST-NET address so the SSRF guard treats it like a real site. Anthropic goes via `ANTHROPIC_BASE_URL`. |
| Fake clock | `env.sh` | libfaketime (`apt install faketime`) with `$E2E_CLOCK_FILE` (`+NNNm`) in Postgres, Next, the gateway, fakes and the driver. `start.sh` sets it to 09:05 Toronto; the driver moves it forward (tap → test, 2 h fallback, 24 h escalation). PostgREST is static (unaffected), so JWTs are minted with a backdated `iat`. The browser runs unfaked with Playwright's clock set to the harness time. |
| Driver | `run.ts` | Stripe checkout (fake Stripe client) → **signed** `checkout.session.completed` to `/api/webhooks/stripe` → billing worker loop; Playwright (Chromium at `/opt/pw-browsers/chromium-1194`, override with `E2E_CHROME`) for `/setup`, `/s/<slug>`, `/forward`, sign-in, dashboard/progress, concierge; one real `runScheduler` tick then the same passes it runs (awaited), plus the worker's queue drains; signed Twilio voice webhook for the forwarded test leg. |

Hosts: buyer links use `http://app.crankleads.localhost:55439` (branded like app.crankleads.com),
operator links `http://localhost:55439`. Chromium resolves `*.localhost` itself; Node needs
`127.0.0.1 app.crankleads.localhost` in `/etc/hosts` (run.sh checks).

## Steps and assertions

0. A non-CrankLeads house tenant is seeded (snapshot taken).
1. Close purchase for "Northshore Snow & Lawn", owner +17055550142, through the webhook + billing worker.
2. Org `platform_brand = crankleads`, tier close; catcher number in 705; welcome email + quick-setup SMS from `TWILIO_FROM_NUMBER`; no "EmpireVu" in any buyer message.
3. `/setup/<token>` at 390px: search, pick the listing, Cell + Bell, one price ($650 seasonal contract), submit.
4. Passes → enriched (website, Google hours, service area, rating, review link, logo, line kind/carrier), exactly two priced services ($650 owner + $250 stated on the site), automations on, booking hours from Google hours, page published (price_page, AI copy kept), forwarding text sent.
4b. Owner signs in mid-setup: dashboard card + progress view at 1280 and 390.
4c. `/s/<slug>` at 390 and 1280; prices, per-day hours + JSON-LD, "Site by CrankLeads", no `aggregateRating`; the quote form creates a CRM contact and the owner gets a new-lead alert.
5. `/forward/<token>` with Android (tel: link) and iPhone (copy code + "I've done it") UAs; one auto test call; forwarded leg via the signed voice webhook → test passed, `live_at` set, exactly ONE "You're live" text + email with the page link, no "✅ text-back is live", no separate page text.
6. Owner after live: `/onboarding` + dashboard at 1280, CrankLeads branding.
7. Operator (`OPERATOR_EMAILS`): concierge list + detail; `rerun_business_lookup` and `build_website` via the API → `operator_actions` rows with status ok; a buyer gets 404.
8. Second buyer (Catch, never answers): switch-on + page after the 2 h fallback; exactly one "Call … to finish setup" operator email at 24 h (none for the live buyer); concierge shows them; house tenant unchanged and never messaged.

The run ends with each buyer's message timeline (Toronto time, channel, first line), the operator
emails, PASS/FAIL per step and the screenshot list; `e2e-results.json` lands next to the shots.

## Phase 1 front desk (`frontdesk.sh` / `frontdesk.ts`)

`scripts/e2e-dfy/frontdesk.sh` starts a fresh stack with `RETELL_INTAKE_ENABLED=1`, a shared
message agent id, `RETELL_FUNCTION_SECRET` and a 200 ms SMS-agent coalesce, then drives
docs/front-desk-ai.md end to end. Shots go to `$E2E_FRONTDESK_SHOTS` (default
`$E2E_ROOT/frontdesk-shots`).

- Seeding: a Close purchase through the signed Stripe webhook + billing worker, price list
  ($650 double-driveway contract, $250 spring cleanup), the real done-for-you `switchOnEverything`
  (so the owner's "forward customer texts" relay is ON), `live_at`; an existing customer Jamie
  Lee; a house org with its own catcher number.
- The "model" (fakes.mjs `smsAgent` / `ownerAgent`) follows the Anthropic tool-use protocol and
  builds replies only from what it was sent (tool results, the fenced "Already collected" data),
  so a reply that mentions the caller's address proves the call context reached the model. It
  captures `images` per request (MMS → image block).
- Fakes added: Twilio MMS media (`…/Messages/MM…/Media/ME…`, Basic auth required), Retell
  `POST /v2/register-phone-call` (returns a `call_id`; `GET /__retell/registered` lists what was
  registered), `POST /__control {"retellRegisterFail": true}` to make registration fail.
- Steps: price question → one AI reply; discount → approval → owner "Y but $575" → quote link;
  MMS; complaint → hand-off; owner commands (agenda, move + Y, "tell Jamie"); forwarded call →
  `<Dial><Sip>` → signed Retell `call_analyzed` → lead, owner alert, one follow-up, caller texts
  back; register failure → voicemail; minutes used up → voicemail + one notice; screenshots
  (inbox, Approvals card, Settings → AI front desk) at 1280 and 390; clock → Monday 08:05 →
  weekly report text + email, second run silent, report page shots; house org untouched. Ends
  with the message timeline.

## Phase 2 AI staff (`staff.sh` / `staff.ts`)

`scripts/e2e-dfy/staff.sh` starts a fresh stack (200 ms SMS-agent coalesce) and drives
docs/ai-staff.md end to end: the four roles through the real database, PostgREST, the Next routes
and the app's own worker code (inbound queue, workflow events + durable waits, `runScheduler` →
`runStaffSweeps`, throttle reset per tick). `staff-results.json` goes to `$E2E_STAFF_OUT`
(default `$E2E_ROOT/staff-out`).

- Clock: moved to the next Sunday 09:05 Toronto first, then forward through the week, so every
  weekday / hour rule is deterministic: Sun 09:05 → 15:05 → 18:05 → Mon 08:30 → 09:30 → 09:45 →
  10:05 → 10:10 → 10:16 → 10:30 → Tue (+2 d after the quote) → Fri 09:30.
- Seeding: a Close purchase (signed Stripe webhook → billing worker) + switch-on + live; website,
  Google place id, price list; Bob (overdue invoice), Pat (invoice), Sam + Jo (spring cleanups
  Monday), Al (Monday job assigned to crew member Mike), ten past customers (completed jobs 3–30
  months ago, two contacts sharing one number, one with lapsed implied consent); a house org
  (A1-style) with the same shapes (overdue invoice, past customer, job tomorrow, crew cell).
- Fakes added: Open-Meteo (`api.open-meteo.com` / `customer-api…`, hourly unixtime; rainy where
  `POST /__control {"rain":[{fromMs,toMs}]}` says), Places details `location` (geocoding),
  Anthropic estimator vision (JSON estimate; counts image blocks), win-back / review reply /
  Google post copy, the SMS agent's `request_estimate` / `request_payment_plan` and the owner
  agent's `who_owes_me` / `marketing_results` (every request captures the tool list it was
  offered). The gateway gained a minimal Storage stub (`/storage/v1/object/<bucket>/<path>`,
  service-role upload, download; files in `$E2E_ROOT/storage`, a `storage.objects` row each).
- Steps: R routes (GET every role's ai-settings as the owner, PATCH dispatch sensitivity, member
  cell PUT/GET, a member can read but not PATCH, PostgREST RLS read/write) · E1 photo + "how much
  to fix my fascia?" → `request_estimate` → photo in `quote-photos` → `ai_estimate` (no price to
  the customer) · E2 "Y n $900" → `estimator` quote $900 + HST texted once · B1 nothing on a
  Sunday; "can I do 3 payments?" → `payment_plan` → Y → plan + hold, confirmation queued · B2
  "who owes me" · D1 15:00 rain → ONE `weather_reschedule` → Y → moved + texted with `/v/` links,
  no gap offers for its own moves · D2 18:00 crew text once · B3 nothing at 08:30, Bob's reminder
  with `/i/` link at 09:30 (once), Pat's queued plan text goes out, no reminder under the plan ·
  D3 job completed → no crew update · M1 monthly win-back → `marketing_campaign` (7 numbers,
  exact text, STOP + website) → a STOP before sending → Y · M2 ≤5 per 5-minute slot, never to the
  opted-out number (either contact), STOP after a text, a recipient's reply answered by the
  assistant, "how did the campaign do?" · E3 +2 d one follow-up (the active quote-follow-up
  automation's), +5 d the Estimator's own nudge · H house tenant: no texts, no role rows, job not
  moved, owner agent without role tools, and with its texting assistant switched on the model gets
  exactly the Phase 1 tool list. Ends with the message timeline and `N/N steps, N/N checks`.

## Phase 3 office staff (`phase3.sh` / `phase3.ts`)

`scripts/e2e-dfy/phase3.sh` starts a fresh stack on its own ports and data dirs (566xx,
`E2E_ROOT=/var/tmp/e2e-p3`, `/var/tmp/e2epg-p3`, `/var/tmp/e2esock-p3`, `/var/tmp/e2e-faketime-p3`;
each can be overridden) with a fixed `PORTING_ENCRYPTION_KEY`, waits for an earlier run's ports to
free, and drives docs/ai-staff.md's Office manager, Customer import, Keep your number and Hiring &
payroll. Re-runnable (every run starts from a fresh database); `E2E_STOP=1` stops the stack after.
`phase3-results.json` goes to `$E2E_PHASE3_OUT` (default `$E2E_ROOT/phase3-out`).

- Clock: the next Saturday 13:05 Toronto, then Sun 07:05 / 08:05 / 10:00 / 18:05, Mon 06:55 /
  07:01 / 08:05 / 09:30 / 10:00 / 21:30, Tue 07:01 / 08:05 / 08:31.
- Seeding: a Close purchase + switch-on + live + a published site; Bob (35 days late Sunday), Cara
  (crosses 30 days Monday), Monday jobs (one assigned to crew Mike), weekly pay periods from the
  previous Monday (PATCH ai-settings/recruiter), Mike 47.5 h + Ana 6 h clocked, Ana's clock left
  running Sunday evening; an A1-style house org with the Bookkeeper's alert opted in (texts off),
  Hank's invoice crossing 30 days Monday, and a baseline of its inbound voice TwiML.
- Fakes added: `POST /__twilio/incoming` (a number arrives in the Twilio account; `GET` lists them
  with their webhooks), Resend attachments captured with their decoded text, the owner agent's
  `briefing_now` ("today"), `start_hiring` ("I need a labourer…") and `start_number_port` ("keep my
  number"), the Recruiter's job-post draft and screening (captures whether contact details reached
  the model). The gateway's storage stub gained signed upload URLs, list, remove and signed reads.
- Steps: I1 send-link → `/api/public/import/<token>` → signed upload → preview → import → sweep →
  counts, no customer message, done text + `chase_imported_balances` · I2 the email reminder sweep
  skips held balances while an A1 invoice is reminded · B0 Sunday: no briefing, the 8am alert alone
  without held balances · P1 platform / catcher numbers refused, start from Settings, the public form
  (ciphertext only, LOA without secrets) · P2 operator reveal (audited without values) + Mark
  submitted (Twilio snapshot) → the number arrives → business_line + Done text · P3 business-line
  call rings the owner first, no answer → catcher path; A1 voice TwiML unchanged, SMS no AI · O1
  Monday 07:00 exactly one briefing (jobs, overdue without held, the folded 30+ line, "Since
  Saturday: 1 new lead") · O2/R1 no standalone alert, A1's alert as before, `payroll_period` asked ·
  R2 Y → re-ask (open entry) → Y anyway → locked + CSV email; locked edits refused, clock-out allowed
  · O3 "today" → `briefing_now` · I3 no Bookkeeper text on held balances, Y releases · I4 a second
  import, Undo · H1 `job_post` → Y → `/s/<slug>/jobs` · H2 apply → confirmation, screening, digest,
  `interview_invite` · H3 late apply → morning confirmation, Tuesday briefing doesn't count
  applicants, digest, Y → the invite · Z the house org saw none of it.

## Phase 4 receipts, plans, compliance, purchasing (`phase4.sh` / `phase4.ts`)

`scripts/e2e-dfy/phase4.sh` starts a fresh stack on its own ports and data dirs (567xx,
`E2E_ROOT=/var/tmp/e2e-p4`, `/var/tmp/e2epg-p4`, `/var/tmp/e2esock-p4`, `/var/tmp/e2e-faketime-p4`;
each can be overridden) with `E2E_FAKE_STRIPE=1` and a `STRIPE_CONNECT_WEBHOOK_SECRET`, and drives
docs/ai-staff.md's Receipts & HST, Service plans, Compliance and Purchasing, plus the Office
manager's heads-ups. Re-runnable (every run starts from a fresh database); `E2E_STOP=1` stops the
stack after. `phase4-results.json` goes to `$E2E_PHASE4_OUT` (default `$E2E_ROOT/phase4-out`).

- Clock: a Monday M0 chosen so M0+9 … M0+11 sit in the quarter's HST reminder window, then M0+7,
  +8, +9, +11 (07:01 / 09:00 / 15:05), +12 (≈10 days before the first plan visit), +31, +33, +38.
- Seeding: a Close purchase + switch-on + live + a published site, Stripe Connect charges enabled,
  HST registrant + accountant (PATCH ai-settings/tax-clerk); the quarter's invoices (two counted, a
  draft and an imported one not) and expenses (a meal at 50%); a sub + their WSIB clearance through
  Settings → Compliance; a supplier + a roof recipe through Settings → Purchasing; an A1-style
  house org with a rule-based weekly recurring series and job-done invoicing (snapshot taken).
- Fakes added: `POST /__media {id, contentType, spec}` registers MMS media (a JPEG / PDF carrying
  `E2EDOC{spec}E2EDOC`) served at Twilio's `…/Media/ME…`; the receipt reader and the compliance
  reader answer only from that spec; the SMS agent's `share_compliance_doc` and the owner agent's
  `materials_status`; a Stripe fake (customers, Checkout Sessions on a connected account, retrieve
  / expire; `GET /__stripe/sessions`) reached through `intercept.cjs`, which (only with
  `E2E_FAKE_STRIPE=1`) sends the SDK's `https` requests for api.stripe.com to the fakes server;
  Resend attachments are captured with their size and the reply-to.
- Steps: R1 receipt photo + "Jones job" → expense on the booking, file in expense-receipts, one
  reply · R2 duplicate · R3/C1 "insurance certificate" → Compliance (never read as a receipt) · R4 a
  bare photo → "Got the picture" · P1 plan via Settings, `/s/<slug>/plans` · P2/P3 sign-up → 303 to
  Checkout on the connected account → signed Connect webhook → active + one series on the plan
  months, texts · C2 a customer asks for proof of insurance → `share_compliance_doc` → Y → link →
  302 to the file · H1 A1 photos take the old paths · P4 Monday renewal batch → `plan_renewals` → Y
  → renewal link · C3 30-day text, expired link 410, a revoked link 410 · T1/T2 HST reminder
  (figures) → `accountant_packet` → Y → PDF + 2 CSVs · C4 `request_sub_docs` → Y → upload link · U1
  two quoted jobs → `materials_order` × 2 · U2 "N n" for a share while orders wait · U3 "Y n
  delivery" / "Y n" → supplier emails (no customer name, no prices) · O1 the 07:00 briefing's
  heads-ups, ≤ 612 septets · C5 the sub uploads through the public link · U4 the pickup reminder ·
  U5 a "PO-n" receipt → actual in `materials_status` · P5 visit heads-up · C6/C7 7-day and expiry
  texts · P6 lapse (only untouched future visits removed) · P7 a prepaid plan visit isn't invoiced
  again · Z the house org saw none of it; its series and invoicing unchanged.

## Phase 5 email inbox, customer care, profit advisor, fleet (`phase5.sh` / `phase5.ts`)

`scripts/e2e-dfy/phase5.sh` starts a fresh stack on its own ports and data dirs (568xx,
`E2E_ROOT=/var/tmp/e2e-p5`, `/var/tmp/e2epg-p5`, `/var/tmp/e2esock-p5`, `/var/tmp/e2e-faketime-p5`;
each can be overridden) with `INBOUND_EMAIL_DOMAIN=in.crankleads.test` and a `RESEND_WEBHOOK_SECRET`
(`whsec_…`, the one fakes.mjs signs with), and drives docs/ai-staff.md's Email inbox, Customer care
& warranty, Profit advisor and Fleet & equipment, plus the Office manager's heads-ups. Re-runnable
(every run starts from a fresh database); `E2E_STOP=1` stops the stack after.
`phase5-results.json` goes to `$E2E_PHASE5_OUT` (default `$E2E_ROOT/phase5-out`).

- Clock: the Monday D0 whose Tuesday D1 is the first Tuesday of its month (the monthly price
  check), then D0 09:15 → 16:45, D1 08:15 / 09:05 / 10:05 / 12:00 / 16:50, D2 10:05 / 10:40,
  D3 08:30, D4 10:05 / 15:05 / 16:30, D5 07:01 / 10:05.
- Seeding: a Close purchase + switch-on + live, crew (Mike, Ana) with pay rates, six months of
  costed jobs (time entries, receipts on the job, invoices) and eight gutter-cleaning quotes (7 won)
  so the $189 gutter cleaning is underpriced, this week's three jobs (Jones +$1,260, Smith −$90 with
  9 h of labour over, Ng), three customers for Customer care, a supplier (Settings → Purchasing); a
  second CrankLeads company (Bayview) for inbox tenancy; an A1-style house org with review requests
  and job-done invoicing.
- Fakes added: Resend Inbound — `POST /__resend/inbound` registers a received email (+ attachment
  bytes), served at `GET /emails/receiving/{id}` and `…/attachments/{aid}` (a `download_url` on
  `inbound-cdn.resend.app`, which intercept.cjs routes here); `POST /__resend/deliver {id, url,
  badSignature?, staleSeconds?}` sends the Svix-signed `email.received` webhook to the app;
  outbound emails are captured with their `headers`. Anthropic: the email classifier and drafter
  (a gullible drafter that obeys "ignore all previous instructions" so the guards are what's
  tested), the odometer reader; the SMS agent's `record_job_feedback` / `check_warranty` /
  `book_care_visit` (`POST /__control {carePick}` = the slot the customer picked); the owner
  agent's `email_setup`, `cash_forecast`, `add_vehicle`, `set_service_schedule`, `add_rental`,
  `rental_returned`.
- Steps: E1 "set up my email" → the address + steps · E2 Gmail confirmation → the code (not stored)
  · E3 a new customer's email (PDF / inline / .exe) → contact, inbound `message_log` (in
  `ui_inbox_v`), files kept, `email_reply` → Y → the reply with Reply-To = inbox, In-Reply-To /
  References, "Re: …" · E4 retry no-op · E5 bad / stale signature 400 · E6 tenancy (Bayview's inbox,
  an unknown address) · E7 newsletter / supplier / bill → one 16:00 digest · C0 jobs done: check-ins
  planned (Pat's moved a day by her review request), warranties · F1/F2 fleet by text → one
  combined 09:05 heads-up (rental today, oil change by the km projection, plate sticker 7 days) ·
  P1 price check → Y → $189 → $215 once, a second Y "already" · C1 Kim "5" → thanks only · F3 rental
  returned + cost, odometer photo logged, fuel receipt photo → the tax clerk · P2 cash forecast ·
  H1 A1 photos · C2 Pat's review request unchanged · C3/C4 Pat "2 - still leaking" → one text with
  two codes → Y visit → times → pick → "Callback: …" booked · C5 Kim's warranty claim → Y → no-charge
  visit · C6 Lee's job auto-invoiced, "1" left waiting · W1 the Friday text word for word · C7 care
  visits done: no invoice, no check-in · E8 prompt injection → holding reply · O1 Saturday briefing:
  care / fleet / email / profit heads-ups, one each, ≤ 612 septets · Z the house org saw none of it.
