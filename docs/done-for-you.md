# Done-for-you CrankLeads

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
