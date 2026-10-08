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
