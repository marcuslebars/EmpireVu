# Done-for-you CrankLeads

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
them update their answers (re-submit → re-enrich).

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
- **Google Places (New) details** for the picked listing: hours; locality → service area
  ("<Town> and surrounding area"); website; rating + review count; review link
  `https://search.google.com/local/writereview?placeid=<id>`. No review text or photos are
  stored.
- **Website crawl** (`dfy/crawl.ts`): the homepage plus up to 5 same-site services / pricing /
  rates / about / contact pages. Every fetch goes through the shared SSRF guard
  (`src/server/net/safe-fetch.ts`: DNS and every redirect hop are checked; size and time are
  capped). The catalog parser uses the same guard.
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

**Env**
- `GOOGLE_PLACES_API_KEY` [web, workers]: a Google Cloud key with **Places API (New)** enabled
  (Text Search + Place Details). Restrict the key to that API. If it isn't set, Places is
  skipped (logged once) and the page offers only website / no website.
- Prices from the website also need `ANTHROPIC_API_KEY`. Without it that step is skipped and
  recorded.

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
| Call buttons, sticky mobile bar | `companies.owner_phone_e164` (the business line callers know, not the text-back number) |
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
   the same words are in the owner's own facts. A rejected field keeps the template version;
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
2. `notifyPublishedSites` — every published CrankLeads site with `owner_notified_at` null, between
   08:00 and 21:00 company time: claim, then text the owner from `TWILIO_FROM_NUMBER`
   (`smsFrom: "platform"`): "Your new page is live: <url>. Want changes? <app>/settings?section=website".
   A landline business number gets the same by email. Publishing from Settings stamps
   `owner_notified_at` (they already know).

Regeneration is owner/operator-triggered (Settings → Your website → Regenerate, or
`generateSite(admin, companyId, { publish })` from the concierge console).

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

`siteUrl(slug, brand)` = `PAGES_BASE_URL/<slug>` when set, else `appBaseUrlFor(brand)/s/<slug>`.

### Env

- `PAGES_BASE_URL` **[web, worker]** — e.g. `https://pages.crankleads.com` (no trailing slash).
  Unset → links use `/s/<slug>` on the app host, which works with no DNS change.
- `TURNSTILE_SITE_KEY` (or the existing `VITE_TURNSTILE_SITE_KEY`) **[web]** — renders the
  Turnstile widget on the page's form. Add the pages host to the Turnstile site's hostnames.

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
