# Done-for-you CrankLeads

A CrankLeads buyer never sets anything up. They pay, answer three questions on their phone,
tap one link, and we tell them they're live. Four parts make that happen; they meet only
through database state, so each can be read on its own below.

## What the buyer experiences

Times are typical for a Catch / Close buyer who answers straight away (Front Desk is the same,
with the AI receptionist's number instead of the text-back number). Every owner text comes from
the platform number (`TWILIO_FROM_NUMBER`) and only between 08:00 and 21:00 their time; anything
due at night waits for the morning.

| When | They get | Sent by |
| --- | --- | --- |
| **0 min** — they pay | `/welcome/crankleads` page: *"Check your texts — we'll finish setting things up for you"* and the four steps below. **Welcome email**: we're setting things up, the quick-setup link, the set-password link (no DIY steps, no time estimate). Their number is bought in the background. | billing worker (`crankleads/provision.ts`) |
| **0 min** (08:00–21:00 their time) | **Quick-setup text**: *"CrankLeads: you're in. 60 seconds and we'll set the rest up for you: …/setup/<token>"*. Bought at night → the text waits for the retry sweep from 08:00 (the welcome email already carries the link; an email copy goes now only if the welcome email failed). Retried up to 3× if it didn't go. The concierge resend outside hours sends the email only and says so. | `dfy/intake.ts` |
| **~1–5 min after they answer** | Nothing to read — we look up their Google listing + website, switch every automation on and build + publish their page. | enrichment → orchestrator (page built inline) |
| **right after that** | **Forwarding text + email** (once): *"… is almost live. Last step: turn on call forwarding … It's one tap: …/forward/<token>"*. | orchestrator |
| **~1 min after they tap** | We place one automatic test call. | orchestrator → forwarding test |
| **the moment forwarding is verified** | **ONE "🎉 You're live" text + email**: what works now, their number, **their page link** (if it's published), a login link (the email carries a one-time set-password link if they never signed in). | forwarding test pass / orchestrator → `setup-followups.ts` |
| **only if their page publishes after that** | **"Your new page is live: <url>"** text, once. | sites sweep |

If they don't answer the quick setup within 2 hours, we switch on and build the page from what
we already have (checkout details + their trade pack) and send the forwarding text anyway; a
late answer rebuilds the page once with the new facts.

Not live yet? Reminders (one thing, one link) go on business days 1 / 3 / 5 / 10, 09:00–18:00,
never within 3 hours of purchase or of a quick-setup / forwarding text, and stop the moment
they're live. Not live 24 hours after purchase → Marcus (or a closer) gets "Call <name>" and
finishes it from the concierge console.

What they never get: the 8-step wizard, a "connect Stripe" chase, two texts for the same moment
(a forwarding pass that makes them live sends only "You're live", not also "✅ text-back is
live"), or the page link twice.

## Who done-for-you applies to

- **New-flow purchases only.** Every purchase provisioned with this feature gets a
  `setup_intakes` row at provisioning (step 3b — a required, retried step). That row is the
  marker: switch-on, number buying, site generation / publishing and the page text run only for
  companies that have one (`dfy/eligibility.ts`). CrankLeads companies bought before
  done-for-you ("legacy") are never switched on, sold a number, auto-published or texted. An
  operator can build a legacy company a **draft** page from the concierge ("Build / rebuild
  website" publishes only for new-flow companies); "Resend quick-setup link", "Send forwarding
  text" and "Run switch-on now" refuse legacy accounts with a plain message.
- **Stop flags silence every owner text.** `crankleads_purchases.setup_followups_exempt_at` /
  `setup_reminders_stopped_at` stop the quick-setup text (purchase, retries and operator resend),
  the forwarding text, the page text (the site is marked handled without a send), the
  forwarding-test result notice and "You're live".
- **Only the tier's automations run.** After provisioning (and at switch-on) every catalog
  recipe outside `packRecipesForTier(tier) ∪ dfyRecipeSlugs(tier)` is draft
  (`crankleads/tier-automations.ts`). Existing orgs: see "Repair: tier automations" below.

### Repair: tier automations (one-off, existing CrankLeads orgs)

Orgs provisioned before the tier rule may have Close / Front Desk automations running.
`npm run job:crankleads-repair-automations` lists, per CrankLeads company, every ACTIVE catalog
recipe outside its tier (dry run — changes nothing). `npm run job:crankleads-repair-automations -- --apply`
sets those to draft. Idempotent; custom workflows and house orgs are never touched; nothing is
turned on. Needs `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Run the dry run first
and read the list before applying.

## Intake & enrichment

**What the buyer sees.** Right after provisioning (`provisionClaimed`, just after the welcome
email) we create one `setup_intakes` row for the company and text the owner from the platform
number (`TWILIO_FROM_NUMBER`, `smsFrom: "platform"`):
*"CrankLeads: you're in. 60 seconds and we'll set the rest up for you: <app>/setup/<token>"*.
The welcome email no longer lists DIY steps — it says we're setting things up, to check their
texts, includes the same link, and keeps the set-password link. If the text can't go (or the
welcome email failed) an email backup *"Your 60-second setup link"* goes out under the org's
brand name. The hook is wrapped in try/catch: it never fails provisioning.

**The page** `/setup/:token` (public, no login, `src/screens/SetupIntakePage.tsx`, branded from
the org): 1) find your business on Google (server proxy), or paste a website, or "No website";
2) business phone (prefilled from checkout), cell / landline / VoIP, carrier; 3) prices for the
pack's services (optional; "Skip — we'll ask later"; "Add a service"). Submit → "Done. We're
building everything now — we'll text you in a few minutes." Re-opening shows a summary and lets
them update their answers (re-submit → re-enrich; only owner prices that CHANGED since the
previous submit are written, so a price edited in the app since isn't overwritten). Once they're
live the page is a read-only summary (answers are refused), and the link stops working 30 days
after the purchase.

**Who sees the links.** `/setup/<token>` and `/forward/<token>` are no-login credentials. The
token columns are not readable by any client role (migration `20261008150000`); the in-app
progress view hands the links to owners and admins only — members see the status.

**API** (`src/app/api/public/setup/[token]/…`). The token is 24 random bytes (base64url) and is
the only credential. Every read and write is scoped to that token's org + company, and requests
are rate-limited per token and per IP:
- `GET`: the page state (marks `opened_at`).
- `POST`: the answers (zod, plain-English errors).
- `GET places?q=`: Google Text Search proxy (name + address only).

**Statuses.** `pending` → `sent` → `opened` → `submitted` → `enriching` → `enriched` | `failed`.
Other parts react to `enriched` (`enriched_at`).

Setup-link retries: `processPendingIntakeSends` (runs on every scheduler pass) retries
`pending` intakes:
- at least 10 min after the last try;
- only 08:00–21:00 company time;
- at most 3 tries (`send_attempts`).

Each try is claimed with a conditional update, so two workers never send the same text twice.

**Enrichment** (`src/server/services/dfy/enrich.ts`). `processPendingEnrichments` runs from the
scheduler and is not awaited. Each intake is claimed with a conditional update. A crashed run
is reclaimed after 15 min, a failed run is retried up to 3×, and a re-submit during a run sends
it round again.
- **Is it their listing?** Before anything from the picked listing is used, it must match:
  its phone equals the business line or the owner's phone, **or** its name shares at least half
  its words with the company name (ignoring "inc", "ltd", "services"…). No match → nothing from
  it is used (no rating, review link, hours, website / crawl, service area, prices, place id) and
  `enrichment.listingCheck` records why; the concierge call script shows "Listing needs a check".
- **Google Places (New) details** for the picked listing: hours; locality → service area
  ("<Town> and surrounding area"); website; rating + review count; review link
  `https://search.google.com/local/writereview?placeid=<id>`. No review text or photos are
  stored.
- **Website crawl** (`dfy/crawl.ts`): the homepage plus up to 5 same-site services / pricing /
  rates / about / contact pages. Every fetch goes through the shared SSRF guard
  (`src/server/net/safe-fetch.ts`: DNS and every redirect hop are checked; size and time are
  capped). The catalog parser uses the same guard. Addresses are classified from their bytes
  (any IPv6 spelling; IPv4-mapped / NAT64 / 6to4 / Teredo and the RFC 6890 IPv4 ranges are
  refused), and every connection goes through an undici dispatcher whose `connect.lookup`
  re-checks every resolved address at connect time — a DNS-rebinding answer can't slip in
  between the check and the fetch. A homepage that isn't HTML / text is refused.
  - From the pages: logo (logo `<img>` > apple-touch-icon > og:image > icon), meta description,
    hours text and phone numbers.
  - Services and stated prices come from the catalog parser, which now reads several pages.
- **Company writes**:
  - Google / website facts: `website`, `hours` (`{summary, periods}`; `summary` is what
    onboarding and the receptionist already read), `service_area`, `brand_logo_url`,
    `brand_review_url`, `google_*`.
  - The buyer's phone answers: `business_phone_kind` / `business_phone_carrier`,
    `brand_reply_phone`, and `owner_phone_e164` if they corrected it (never set to a landline).
  - Profile copy: `profile.tagline` / `profile.about`.

  `profile.source[field]` records where each automatic value came from. A non-empty value with
  no recorded source was set by hand and is never overwritten.
- **Prices**: the owner's intake price wins. Otherwise we use a price stated on their own site,
  only when:
  - the service name matches conservatively;
  - the unit is the same;
  - the item has no price yet.

  Flat-priced services on the site that match nothing are added. Prices are never invented,
  and priced items are switched on. Everything applied or skipped is recorded in
  `setup_intakes.enrichment` (`sources`, `company.applied/kept`,
  `services.priced/added/unpricedOnSite/notApplied`, `facts`).

If `GOOGLE_PLACES_API_KEY` isn't set, Places is skipped (logged once) and the page offers only
website / no website. Prices from the website need `ANTHROPIC_API_KEY`; without it that step is
skipped and recorded.

**Migration** `20261008110000_setup_intake_delivery.sql` adds `send_attempts`, `sms_sent_at`,
`email_sent_at` and `enrich_attempts` to `setup_intakes`.

## Automatic switch-on

A CrankLeads buyer never works through a wizard. After they pay we buy their number, switch
everything on as soon as we know enough about the business, text them ONE link that turns on
call forwarding, test it ourselves, and tell them "You're live". If they aren't live 24 hours
after buying, an operator gets a task to call them.

### What happens, in order

| When | What | Where |
| --- | --- | --- |
| Purchase provisioned (billing worker) | An active number of either kind already there → ready (a Front Desk buyer on the catcher path is never sold an AI number on top). Otherwise buy the tier's number right after the company exists: **Catch / Close** → the missed-call text-back (Twilio catcher) number; **Front Desk** → the AI receptionist's (Retell) number. Area code = the checkout phone's NPA (fallback 705; then any). Never fails provisioning — a failure is recorded and retried. | `crankleads/provision.ts` step 6b → `dfy/numbers.ts` `ensureDfyNumber` |
| Every minute (worker scheduler, `runDoneForYouSweep`) | `processDoneForYou` advances up to 25 provisioned, not-live CrankLeads companies (least recently advanced first, purchases from the last 30 days). | `dfy/orchestrator.ts` |
| Number missing | Retry with backoff (1 min, 5 min, 20 min, 1 h; own area code ×2, then 705, then any). After 5 failed attempts: `number_flagged_at` + one operator email; shows in the daily health email. | `ensureDfyNumber` |
| `setup_intakes.status = 'enriched'` — or the intake is ≥ 2 h old and unanswered, or stuck in submitted/enriching ≥ 6 h (no intake row = legacy: never) | **Switch on, once** (`switched_on_at`, details in `switch_on_detail`). A run that throws or whose automations step fails clears `switched_on_at` and is retried on the next sweeps, at most 3 runs (`switch_on_attempts`, then `switch_on_gave_up` — the 24 h escalation / console picks it up); the console's "Run switch-on now" always runs it again (even after a success): install + activate the tier's automations (drafts only; a channel that isn't configured keeps it draft; paused ones are never touched); review requests on when `brand_review_url` exists and the owner never chose; online-booking hours from `companies.hours` while the booking hours are still the defaults; Front Desk: rebuild the AI receptionist prompt (hours, service area, services with any prices) and re-push it to Retell — an update of the same LLM/agent/number, never a new purchase. | `dfy/switch-on.ts` |
| Right after switch-on (same pass) | **Build + publish their page** with `generateSite(…, { publish: true })` unless one exists, so it is usually live before the forwarding / live texts. A failure is logged; the sites sweep is the backstop. An intake enriched AFTER the page was built (the 2 h fallback) rebuilds it once (keeps slug, status, owner edits). | orchestrator `buildSiteInline` |
| Switched on + number bought + not verified, 08:00–21:00 company time | **Forwarding text + email, once** (`forward_text_sent_at`), from the platform sender (`TWILIO_FROM_NUMBER`), with the no-login link `/forward/<token>`. | `sendForwardingLink` |
| Owner taps (Android) / confirms (iPhone, landline) | `forward_tapped_at`. ~45 s later (next page poll or sweep) ONE automatic forwarding test via the existing owner-test path (rate-limited, the company's own business line). Outside 08:00–21:00 their time nothing is claimed: the test goes on the first sweep after 08:00 and the page says "we'll call … after 8am". Each new tap allows another (max 5); the existing daily/weekly re-tests carry on. Catcher path only — see Front Desk below. | `dfy/forwarding.ts` |
| Not live at purchase + 24 h, moved into operator hours (Mon–Fri 08–18, `BUSINESS_TIMEZONE`) | **Escalation, once** (`escalated_at`): email to `OWNER_EMAIL` — "Call <name> <phone> to finish setup — <business>" with what's done / left and `${APP_BASE_URL}/concierge/<organizationId>`. Also listed in the daily operator health email ("Finish setup for them (concierge)"). | orchestrator step 5, `operator-health/*` |
| "Have us set it up — we'll call you" on the forwarding page | `forward_help_requested_at` + one operator email (same format, with the line kind/carrier). Listed in the daily health email. | `forwardingHelpHandler` |
| Forwarding verified (a passing forwarding test — immediately, from `completeForwardingTest`; or the next orchestrator tick; the 5-min follow-up pass is the backstop) | `crankleads_purchases.live_at` + ONE "You're live" text + email (08:00–21:00): what now works, their number, their page if published (`siteUrl(slug)`; the site's `owner_notified_at` is stamped so the sites sweep never sends its own page text), a login link (the email carries a one-time set-password link if they never signed in — buyer's checkout email only; the text never does). When this message covers the pass, the forwarding test's "✅ text-back is live" note is NOT sent. All paths share the same claims (`live_at`, the `(purchase, 'live')` follow-up row), so it goes once. | `crankleads/setup-followups.ts` `processSetupFollowupForCompany` |

### "Live" (new definition — `crankleads/setup-checklist.ts`)

- **Catch / Close** (and Front Desk that chose the catcher): text-back number active **+** forwarding verified (`voice_numbers.forwarding_verified_at`: a passing test or a real forwarded call) **+** the missed-call text-back automation active.
- **Front Desk**: AI number active **+** forwarding verified on that number **or** a call to the AI receptionist that shows forwarding from the business line (rule under "Front Desk" below — a call alone doesn't count).
- Prices, payments (Stripe), the website form, the team and the test call are **not** required. They are `extras` on the checklist (shown in the app as "Optional"), never chased. Nothing asks for Stripe: an owner meets the existing "connect Stripe" explanation the first time they try a deposit or card payment.

Everything reading the checklist follows: the follow-ups, the operator health email (setup stalled / guarantee), the dashboard card, the onboarding API.

### Follow-ups (rewritten)

Same schedule (business day 1/3/5/10, 09–18 company time, one per day, stop link), but each reminder asks for exactly ONE thing with ONE no-login link: the 60-second quick setup (`/setup/<token>` while `setup_intakes.status` is pending/sent/opened) or else the forwarding tap (`/forward/<token>`). No wizard steps, no Stripe, no set-password link. The day-10 operator "stuck" email is gone — the 24 h escalation replaces it.

Quiet rule (`reminderQuietReason`): no reminder in the first 3 hours after purchase, or within 3 hours of the latest quick-setup text (`setup_intakes.sms_sent_at` / `sent_at` — an operator re-send counts) or forwarding text (`dfy_progress.forward_text_sent_at`); the reminder goes on a later pass that day or the next business day. Reminders stop once `live_at` is set.

A failed automatic test (`not_forwarded`) texts the fix with a link to the one-tap page `/forward/<token>` instead of the wizard.

### In the app

CrankLeads orgs see **"We're setting you up"** at `/onboarding` instead of the 8-step wizard, and a small card on the dashboard instead of "Finish setting up": ✓ number bought, ✓ business details found, ✓ automations on, ✓ your page is live with its link (only when a `company_sites` row exists), the one thing left (turn on forwarding → the same one-tap page), and optional extras (add prices, connect payments). Data: `GET /api/organizations/{orgId}/setup-progress` (`dfy/progress-view.ts`). Non-CrankLeads orgs keep the wizard.

### The one-tap forwarding page (`/forward/:token`)

Public, no login; the 32-char `dfy_progress.forward_token` is the credential (rate-limited per IP and per token, `noindex`, returns only the business name, the number to forward to, the code and the verification state). API: `GET/POST /api/public/forward/{token}` (`POST {action: "opened" | "tapped" | "help"}`; GET never changes state except starting the one auto-test after a tap, which a link scanner can't do).

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

Forwarded calls go to the Retell number, which our Twilio forwarding test can't observe. No automatic test call is placed for Front Desk; the page tells the owner to call their business line from another phone and let it ring. A call that merely reaches the AI number is **not** proof (the owner may have dialled the AI number directly). The exact rule (`dfy/front-desk-forwarding.ts`, used by the checklist and the forwarding page):

Forwarding is verified when the AI number's `voice_numbers.forwarding_verified_at` is set, or a `retell_calls` row for the company — inbound, to its active AI number — is either
1. **marked forwarded from the business line**: a `forwarded_from` / `diversion` / `redirecting_number` value (top level, under `call`, or inside `sip_headers` / `custom_sip_headers` / `telephony_identifier` of the stored payload) whose last 10 digits equal the business line (`brand_reply_phone ?? owner_phone_e164`). Retell's call webhook today gives `from_number` / `to_number` / `direction` and no standard diversion field, so this is used only if a carrier's diversion info shows up; or
2. **received after the owner said they turned forwarding on** (`dfy_progress.forward_tapped_at`) from a caller that is neither the business line itself nor the AI number.

A call before the tap, or from the business line, never counts.

### Data

Migration `20261008120000_dfy_autolive.sql` (rollback `supabase/rollback/20261008120000_dfy_autolive.down.sql`): `dfy_progress` (one row per company; RLS: members select; service role writes only) — `number_attempts`, `number_last_attempt_at`, `number_last_error`, `number_ready_at`, `number_flagged_at`, `switched_on_at`, `switch_on_detail`, `forward_token` (unique), `forward_text_sent_at`, `forward_opened_at`, `forward_tapped_at`, `forward_help_requested_at`, `forward_tests_started`, `forward_last_test_at`, `escalated_at`, `last_run_at`, `last_error`. Operator fix for a flagged number: the console's **Retry text-back number** (clears `number_flagged_at` + `number_attempts` and buys now).

Reads (owned by other parts): `setup_intakes` (status, token), `company_sites` (status, slug), `companies.hours / business_phone_kind / business_phone_carrier / brand_review_url`.

## Generated sites

Every CrankLeads buyer gets a hosted, phone-first page built from the facts we hold about their
business. If they have **no website**, the page *is* their website (`full` mode). If they **have
one**, it's their services, prices and booking page they can link to (`price_page` mode), with a
"Visit our main site" link back.

### What's on the page

Built only from facts (nothing is invented):

| Section | Source |
|---|---|
| Name, logo (or a wordmark), colours | `companies.name`, `brand_logo_url` (https only), `brand_primary_color` / `brand_accent_color`, else a palette per trade |
| Call buttons, sticky mobile bar | the business line: `brand_reply_phone ?? owner_phone_e164` (same rule as `resolveBusinessLine`; never the text-back number) |
| Services and prices (rate sheet) | **active** `service_catalog_items`; price text derived from cents only. Unpriced rows (or "Show prices" off) show "Get a quote" |
| Service area, hours | `service_area`, `hours` (`{summary}`, per-day `{mon:{open,close}}`, or Google `weekdayText`) |
| Rating badge + "Read our Google reviews" | `google_rating` + `google_review_count` (both required), `brand_review_url` / Google Maps link. No review text |
| About, tagline, highlights | `companies.profile` |
| Quote form | the company's active public form key → `POST /api/public/forms/<key>` (same abuse layers as the hosted form: rate limits, honeypot, min fill time, Turnstile when `TURNSTILE_SITE_KEY`/`VITE_TURNSTILE_SITE_KEY` + secret are set). Requests become normal leads |
| Book online | the public booking page, only while online booking is on |
| Footer credit | "Site by CrankLeads" for CrankLeads orgs only; never "EmpireVu" |

SEO: `<title>`, meta description, canonical, Open Graph, and LocalBusiness JSON-LD (or the
trade's subtype: `RoofingContractor`, `HVACBusiness`, `GeneralContractor`,
`HomeAndConstructionBusiness`) with name, telephone, areaServed, openingHoursSpecification (only
from structured hours), url and sameAs (website, Google Maps). **No `aggregateRating`** —
self-served review markup is against Google's guidelines.

### Copy

`src/server/ai/site-copy.ts` asks Claude (`AI_MODEL_DRAFTS`) for headline, subhead, about,
one-line service blurbs and 3–5 FAQs from a facts JSON that contains **no prices**. The answer is:

1. validated with zod (`siteCopyModelSchema`);
2. screened field by field (`screenSiteCopy`): years, "since 2009", licences, insurance,
   guarantees, warranties, certifications, awards, "family-owned", dollar amounts, star ratings,
   "24/7", "free estimates", "same-day", "emergency", quoted testimonials… are rejected unless
   the same words are in the owner's own facts (service **names** count; service descriptions
   never do — they can be parser- or pack-written). A rejected field keeps the template version;
3. passed through a small US → Canadian spelling fix.

Any failure (no `ANTHROPIC_API_KEY`, API error, invalid JSON) falls back to deterministic
template copy, so generation never blocks. `content.copySource` (`ai` / `mixed` / `template`),
`content.copyNotes` (why) and `content.factsUsed` record what happened.

### Data

`company_sites.content` is versioned JSON (`SiteContent`, version 1): `mode`, `facts` (snapshot),
`factsUsed`, `copy`, `copySource`, `copyNotes`, `edits` (owner overrides), `settings.showPrices`,
`generatedAt`. Regenerate keeps the slug, mode, status, edits and settings. The form key and
booking link are resolved live at render time.

Slugs: from the company name (accents folded, `inc`/`ltd` dropped, ≤ 48 chars), unique with
`-2`, `-3`… and never a reserved path (`api`, `s`, `book`, `setup`…).

Migration `20261008130000_company_sites_owner_notified.sql` adds
`company_sites.owner_notified_at` (claimed before the "page is live" text so it is sent once).

### Done-for-you sweep

`runGeneratedSitesPass` is registered with one line in `runScheduler`
(workflow-engine/scheduler.ts); it runs every 5 minutes per worker and never throws.

1. `generatePendingSites` — CrankLeads orgs (not canceled), companies with **no**
   `company_sites` row and either `setup_intakes.status = 'enriched'`, or **no intake at all**
   (older buyers) plus enough data (a phone and one of: service area, hours, ≥ 3 active
   services). Generates **and publishes**. At most 10 per pass. Idempotent (a company with a row
   is skipped; a racing insert returns the existing row).
   Plus companies the orchestrator switched on (`dfy_progress.switched_on_at`) that still have
   no page — the backstop for the inline build (including the 2 h "no answer" fallback).
2. `notifyPublishedSites` — every published CrankLeads site with `owner_notified_at` null, between
   08:00 and 21:00 company time: claim, then text the owner from `TWILIO_FROM_NUMBER`
   (`smsFrom: "platform"`): "Your new page is live: <url>. Want changes? <app>/settings?section=website".
   A landline business number gets the same by email. Publishing from Settings stamps
   `owner_notified_at` (they already know).
   **Folded into "You're live"** (`pageTextHeldForLive`): while the buyer's done-for-you purchase
   isn't live yet (up to 3 days after purchase), or is live but the "You're live" message
   hasn't gone out yet, the page text waits — the live message carries the link and stamps
   `owner_notified_at`. A page published after go-live gets this text once. Purchases with
   reminders stopped / exempt (no live message) and older buyers get it as before.

The orchestrator builds the page inline right after switch-on (see "Automatic switch-on"), so
the sweep usually finds nothing to do. Regeneration is otherwise owner/operator-triggered
(Settings → Your website → Regenerate, or the console's "Build / rebuild website").

### Owner controls

Settings → **Your website** (`src/components/settings/WebsiteSettings.tsx`): link + status,
Preview (any status, noindex, form disabled), Publish / Unpublish, Regenerate, edit headline /
subhead / about (clear to revert), Show prices, Kind of page. Routes (members read, owners/admins
change; the company must belong to the org):

- `GET|PATCH|POST /api/organizations/:org/companies/:company/site` — view, edits, and
  `{ action: "generate" | "regenerate" | "publish" | "unpublish", publish? }`
- `GET /api/organizations/:org/companies/:company/site/preview` — HTML preview

Help article: `your-website`.

### Serving and caching

- `/s/<slug>` on the app host (route handler `src/app/s/[slug]/route.ts`; excluded from the SPA
  fallback in `next.config.mjs`).
- `/<slug>` on the pages host: when the request host equals the host of `PAGES_BASE_URL`,
  `src/middleware.ts` rewrites to `/s/<slug>`. On that host only `/api/public/forms/*`, `/_next/*`,
  `/favicon.ico` and `/robots.txt` pass through; everything else (including `/`, the app and other
  APIs) gets the neutral 404.
- Only `published` renders. Draft, unpublished and unknown slugs get the same neutral 404.
- `Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300` plus an ETag
  (304 on revalidate). A CDN in front of the pages host can cache for a minute; publish /
  unpublish / edits show within that window.

`siteUrl(slug, brand)` (`dfy/site-url.ts`) = `PAGES_BASE_URL/<slug>` when set, else
`appBaseUrlFor(brand)/s/<slug>`. It is the ONLY builder of a page URL: the "You're live"
message, the page text, the in-app progress view, Settings and the concierge console all use it.

### Turning on pages.crankleads.com (Railway + DNS)

Do these in order; **set the env var last** so no link points at a host that doesn't resolve.

1. Deploy this branch (migration `20261008130000` applied). Sites already work at
   `<app>/s/<slug>`.
2. **Railway:** web service → Settings → Networking → Custom Domain → add
   `pages.crankleads.com`. Railway shows a CNAME target.
3. **DNS (crankleads.com):** `CNAME pages → <the Railway target>`. Wait until Railway shows the
   certificate issued and `https://pages.crankleads.com/<a published slug>` loads the page
   (the middleware only rewrites once `PAGES_BASE_URL` is set, so before step 5 you'll see the
   app; that's expected).
4. **Turnstile** (if used): add `pages.crankleads.com` to the site's allowed hostnames.
5. Set `PAGES_BASE_URL=https://pages.crankleads.com` on **web and worker**, redeploy. New
   links, canonical URLs and the "page is live" text use the pages host; old `/s/<slug>` links
   keep working (canonical points at the pages host).
6. Optional: put Cloudflare in front of `pages.crankleads.com` to honour `s-maxage`.

Rollback: unset `PAGES_BASE_URL` (links go back to `/s/<slug>`); the migration's down file is
`supabase/rollback/20261008130000_company_sites_owner_notified.down.sql`.

## Concierge console

An operator-only console where Marcus (or a closer) finishes setup **for** a buyer without
signing in as them. Every change is written server-side with the service role, scoped to the
buyer's org + its own company, and audited.

**Who can use it.** `OPERATOR_EMAILS` (web service env): comma-separated, case-insensitive list of
operator emails. A user is an operator only if they are signed in (cookie or `Authorization:
Bearer`, verified with Supabase Auth like every other route), their email is **confirmed**, and it
is on the list. Everyone else — signed out, unconfirmed, not listed, or the variable unset — gets a
plain **404** from every concierge route, and the SPA renders the normal not-found page, so the
console's existence isn't revealed. `GET /api/session/context` returns `isOperator`; the sidebar
shows a **Concierge** entry only when it's true. `OPS_ADMIN_TOKEN` routes are unchanged.
Helper: `requireOperator(request)` in `src/server/services/concierge/auth.ts`.

**Screens.** `/concierge` — CrankLeads orgs (`platform_brand = 'crankleads'`), newest first, filter
chips *Needs a call / Setting up / Live*, tap-to-call/text, tier, hours since purchase with an SLA
badge (green < 12h, amber 12–24h, red > 24h) and progress dots. `/concierge/:orgId` — a *Call
script* header (owner, phone, what's missing in plain words incl. the exact forwarding code for
their line type + carrier), action buttons with confirmations, editable business facts, price
table, activity log (operator actions + automatic reminder sends) and automations.

"Needs a call" = not live and (≥ 24h since purchase, or quick setup `failed`, or the number
purchase gave up, or they tapped "Have us set it up"). The number state comes from the
switch-on part's `dfy_progress`: **active** (bought), **pending**, **retrying**
(`number_last_error`, the sweep retries with backoff) or **failed** (`number_flagged_at`, it gave
up — shown with the last error). The detail also shows the quick-setup status and where
forwarding stands (link sent / opened / tapped, tests run, help requested, verified), and the
page's public URL (`siteUrl`) in the list and the detail. "Live" comes from the setup checklist
evaluator (`loadSetupChecklist`), so it follows whatever rules that module defines.

The **call script** lists only the REQUIRED steps still missing for live (number, forwarding
with the exact code / provider words for their line, the text-back automation), then one short
"Nice to have" line (quick-setup answers, prices, payments, the form on their own site).

**API** (all operator-only, all 404 otherwise):

| Route | |
|---|---|
| `GET /api/concierge/accounts` | list + setup state per company |
| `GET /api/concierge/accounts/:orgId[?companyId=]` | detail (facts, services, automations, activity, follow-ups, call script, registered actions) |
| `GET /api/concierge/accounts/:orgId/actions` | registered actions |
| `POST /api/concierge/accounts/:orgId/actions` | `{ action, companyId?, input }` — JSON only (415) and same-origin (`Sec-Fetch-Site` / `Origin` must match, else 403) |

Any org can be opened by explicit id. A `companyId` is honoured only if it belongs to that org
(else 404 — no write, no audit); by default the org's CrankLeads company is used.

**Actions** (`src/server/services/concierge/actions.ts`, a registry `name → { label, schema, run }`):
`update_business_facts` (website, hours — `{summary}` or per-day `{mon:{open,close}}`, service area,
review link, owner phone, business-line kind + carrier, https logo URL), `set_service_price`
(set/clear price, on/off — an unpriced service can't be switched on; clearing switches it off),
`add_service`, `provision_text_back_number` ("Buy text-back number directly (Twilio)": reuses
`provisionMissedCallCatcher`; area code from the business/owner phone), `run_forwarding_test` (reuses `startOwnerForwardingTest` and its rate
limit / calling hours), `resend_welcome_email` (reuses `resendWelcomeEmail`), `add_note`.
Every input is zod-validated (strict — unknown keys are rejected). The `operator_actions` row
(`operator_email`, org, company, action, `detail.input`) is written **before** the action runs — if
it can't be written nothing happens — and then updated with `status: ok|failed`, the message or
error, and before/after where useful.

Done-for-you actions (`concierge/dfy-actions.ts`, confirm-and-run buttons, same scoping + audit):

| Action | Does |
|---|---|
| `resend_quick_setup_link` — Resend quick-setup link | `resendSetupIntake`: text + email the same `/setup/<token>` again now (stamps `sms_sent_at`, so reminders keep quiet for 3 h). Outside 08:00–21:00 their time only the email goes and the result says so. Refused for legacy accounts and for buyers who stopped setup texts |
| `rerun_business_lookup` — Re-run business lookup | `enrichCompany` (never overwrites facts set by hand) |
| `build_website` — Build / rebuild website | `generateSite(…, { publish: true })` for done-for-you buyers; a legacy account (no quick-setup intake) gets a **draft** only |
| `unpublish_website` — Unpublish website | `setSiteStatus(…, "unpublished")` |
| `send_forwarding_text` — Send forwarding text | `resendForwardingText`: the same forwarding text + email, forced (08–21 their time, needs the number, not once verified) |
| `retry_dfy_number` — Retry text-back number | clears `number_flagged_at` / `number_attempts` and runs `ensureDfyNumber` now (right number type per tier) |
| `run_switch_on` — Run switch-on now | `advanceDoneForYou(…, { force: true })`: switch on (again, even after a success or 3 failed automatic tries) without waiting for the quick setup, build the page, send the forwarding text if it's daytime. Refused for legacy accounts; a failure is shown |

The routes import `concierge/register-all.ts`, which loads both action modules so every action is
registered before the first list / run. Add more with
`registerConciergeAction({ name, label, schema, run })` in a module imported there. `run(ctx, input)` gets
`ctx.admin`, `ctx.tenant` (service-role context pinned to the org), `ctx.organizationId`,
`ctx.companyId`, `ctx.company`, `ctx.purchase`, `ctx.operator`; filter every write by
`organization_id` + company.

Sanctioned service-role surfaces: `services/concierge/accounts.ts` and `actions.ts`, behind
`requireOperator`. No migration (uses `operator_actions` from `20261008100000_done_for_you.sql`).
Tests: `src/test/concierge.test.ts`.

## Scheduler

All done-for-you work runs in the existing workflow-event worker's scheduler pass
(`runScheduler` → `runDoneForYouPasses` in `workflow-engine/scheduler.ts`), once per tick (~1 min),
in buyer order. Each step is wrapped so a failure in one (or in an earlier, unrelated scan) never
stops the others:

| Step | Cadence | Guard |
| --- | --- | --- |
| `processPendingIntakeSends` | every tick | per row ≥ 10 min apart, 08–21 local, ≤ 3 tries, claimed per try |
| `processPendingEnrichments` | every tick, not awaited | in-flight flag per process, per-row claim, ≤ 3 per pass |
| `runDoneForYouSweep` | ≤ once a minute per process | ≤ 25 companies, every once-only step claimed |
| `runGeneratedSitesPass` | ≤ every 5 min per process | ≤ 10 builds per pass, page text claimed per site |
| `processSetupFollowups` | ≤ every 5 min per process | claimed per (purchase, stage) and per local day |

Tests: `src/test/dfy-wire.test.ts` (the buyer message sequence across the parts),
`src/test/dfy-scheduler.test.ts`, `src/test/forwarding-test-service.test.ts` (no double text on a
pass), `src/test/concierge.test.ts`.

## Setup checklist for Marcus

### Environment variables

| Variable | Service | Needed for |
| --- | --- | --- |
| `GOOGLE_PLACES_API_KEY` | web, worker | Quick setup "find your business" + enrichment. A Google Cloud key with **Places API (New)** enabled (Text Search + Place Details), restricted to that API. Unset → website / no-website only. |
| `PAGES_BASE_URL` | web, worker | e.g. `https://pages.crankleads.com` (no trailing slash). Set LAST, after the DNS step below. Unset → pages live at `<CrankLeads app>/s/<slug>`. |
| `OPERATOR_EMAILS` | web | Comma-separated operator emails for `/concierge` (owner + closers; confirmed accounts only). Unset → console off (404). |
| `TURNSTILE_SITE_KEY` *(optional)* | web | Turnstile widget on the page's quote form (or reuse `VITE_TURNSTILE_SITE_KEY`; needs `TURNSTILE_SECRET_KEY`). Add the pages host to the widget's hostnames. |
| `ANTHROPIC_API_KEY` *(existing)* | web, worker | Prices from their website + page copy. Unset → those steps are skipped / template copy. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` *(existing)* | web, worker, billing-worker | Numbers, owner texts (from `TWILIO_FROM_NUMBER`), forwarding tests. |
| `RETELL_API_KEY` *(existing)* | web, worker, billing-worker | Front Desk numbers + prompt re-push. |
| `RESEND_API_KEY`, `OUTBOUND_FROM_EMAIL` *(existing)* | web, worker, billing-worker | Owner + operator emails. |
| `APP_BASE_URL`, `CRANKLEADS_APP_BASE_URL` *(existing)* | all | Operator links (`/concierge/…`) / buyer links (`/setup`, `/forward`, `/s`). |
| `OWNER_EMAIL`, `BUSINESS_TIMEZONE` *(existing)* | worker, billing-worker | Operator emails (24 h escalation, number flagged, "have us set it up") and their hours. |

`COMPANY_SITE_BASE_URL` is gone — page links come only from `PAGES_BASE_URL` (via `siteUrl`).

### DNS for pages.crankleads.com

Follow "Turning on pages.crankleads.com" above: deploy → Railway custom domain on the web
service → `CNAME pages → <Railway target>` on crankleads.com → certificate issued → Turnstile
hostname (if used) → set `PAGES_BASE_URL` on web **and** worker → redeploy.

### Migrations, in order

1. `20261008100000_done_for_you.sql` — shared schema (companies columns, `setup_intakes`, `company_sites`, `operator_actions`)
2. `20261008110000_setup_intake_delivery.sql` — intake send / enrich attempt columns
3. `20261008120000_dfy_autolive.sql` — `dfy_progress`
4. `20261008130000_company_sites_owner_notified.sql` — `company_sites.owner_notified_at`
5. `20261008150000_dfy_hardening.sql` — `dfy_progress.switch_on_attempts`; token columns
   (`setup_intakes.token`, `dfy_progress.forward_token`) unreadable by client roles (column
   grants); anon can't read `company_sites`; composite `(company_id, organization_id)` FKs and
   `updated_at` triggers on `setup_intakes` / `company_sites`

The wiring added no migration. Rollbacks are in `supabase/rollback/` with the same names
(`.down.sql`); run them in reverse order.

