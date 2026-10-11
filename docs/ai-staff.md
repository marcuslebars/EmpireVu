# AI staff

CrankLeads replaces everyone in the office except the owner. The AI front desk (docs/front-desk-ai.md) answers calls and texts; the AI staff roles below take the rest of the office jobs. They share the front desk's plumbing:

- **Owner by text** — every sensitive action is an `owner_approvals` row the owner answers with `Y 12` / `N 12` from the platform number.
- **One registry** — `src/server/services/staff/registry.ts` merges each role module (`staff/<role>/index.ts`, type `StaffRoleModule` in `staff/types.ts`) into:
  - the customer SMS agent (extra tools + prompt notes),
  - the owner-by-text agent (extra tools + prompt notes),
  - the approval runner (`owner-channel/approvals.ts` → the role's executor for its own kinds; the result is recorded on the row),
  - the scheduler (`runStaffSweeps`, each sweep throttled and isolated).
- **Settings** — Settings → AI front desk, one section per role (`src/components/settings/staff/*`), each role its own `companies.ai_settings.<section>` key.

Roles: Estimator, Bookkeeper, Dispatcher, Marketer — each section below is written by that role's builder.

## Estimator

## Bookkeeper

## Dispatcher

## Marketer

The Marketer brings past customers back and keeps the Google listing active. It never sends anything commercial, and never puts anything on Google, without the owner's `Y`. Code: `src/server/services/staff/marketer/`. Migration: `20261011130000_staff_marketer.sql` (rollback in `supabase/rollback/`).

**What the owner sees**

- About once a month (local weekday, 10:00–16:00): *"#12 Win-back text to 42 past customers (last job 9-24 months ago): "Hi [first name], it's Northshore Roofing. Fall is a good time to have the roof looked at before the snow - reply here and we'll book you in. Info: https://northshoreroofing.ca Reply STOP to opt out" Sends Mon-Sat 10am-7pm, up to 30/hour. Reply Y 12 to approve, N 12 to skip."* `Y 12` → *"Approved - texting 42 past customers Mon-Sat 10am-7pm, up to 30/hour. Replies go to your assistant. Text "stop the campaign" any time."*
- A new Google review: *"#13 New 5-star Google review from Sam K (https://maps.google.com/…). Reply: "Thanks so much, Sam…" Y = I text you this reply to paste on Google."* (the review's own words are never copied into texts or approvals — the link opens it). 3 stars or less also gets a heads-up text right away (stars, name, link). `Y 13` → a text with the review's Google link and the reply to paste.
- Monday: *"#14 Google post for this week (seasonal tip): "…" Y = I text it to you to paste on your Google listing."* `Y 14` → the copy + `https://business.google.com/posts`.
- By text: "start a win-back" (`start_win_back`: drafts now; the approval is texted right away, even at night, since the owner asked), "stop the campaign" (`stop_campaign`: cancels at once, queued texts skipped, a pending approval superseded) and "how did the campaign do?" (`marketing_results`). Settings has a **Stop this campaign** button (`POST …/ai-settings/marketing/stop`).
- A note on these ("Y 12 $700") does nothing: the item is re-sent under a new code ("goes out exactly as shown… Reply Y 15 to approve it as written").

**CASL consent** (`workflow-engine/messaging.ts` `checkConsent`): `ConsentContact.last_purchase_at` (optional) is the contact's latest completed booking or paid invoice at the sending company; a purchase gives implied consent for **2 years** from that date. Inquiries stay at 6 months, express consent never expires, an opt-out always wins. Callers that don't pass it (reviews, recipes, the SMS agent) are unchanged. Every campaign text names the business, carries contact info (the website, else the published generated site, else the business phone — no contact info → no campaign is drafted) and ends with "Reply STOP to opt out" (deliverMessage doesn't add a second one).

**Win-back campaigns** (`campaigns.ts`, `audience.ts`)

| Step | What happens |
| --- | --- |
| Audience | Past customers of the company whose latest purchase was `months_min`–`months_max` ago (9–24; max is capped at 24), **one per phone number** (last 10 digits; duplicates → `duplicate_phone`). A number is excluded when ANY contact of the company with it opted out (a STOP only opts out the contact it matched), was texted or queued by a campaign in the last 90 days (from `sent_at`, else `created_at`), has an open booking (pending/confirmed) or open quote (sent/viewed/approved/deposit_paid, last 180 days), or bought more recently than `months_min`; the chosen contact also needs consent (checked with the purchase date). Capped at 4 × the weekly cap. All reads page past PostgREST's 1,000-row cap; counts use `count: exact`. |
| Draft | Only with the company's own texting number (`resolveCompanySmsFrom` — never the platform default, which is another business's line) and contact info; otherwise the monthly sweep texts the owner once that month why. `marketing_campaigns` row (unique `company_id, kind, period_key` → once per month; partial unique index → one active campaign per company; skipped within 21 days of the last campaign; a crashed `draft` older than 1h is cancelled and its rows released) → recipients snapshotted as `queued` → Claude writes the body from the business facts (name, trade, service area, price-list services) + a seasonal hook; code rejects money, `%`, "free", deals, urgency and links and falls back to a plain template → `marketing_campaign` approval (48h). No audience → the row is closed `no_audience`, nothing asked. |
| Y | `awaiting_owner → sending` (conditional on the approval id). |
| N / expiry | `cancelled`; queued recipients `skipped` (they don't count against the 90-day cooldown). |
| Sending | Sweep `marketer_campaign_sender` (every 5 min): only inside the send window (Mon–Sat 10:00–19:00 local by default, always within 09:00–20:00), at most `per_hour` (30) per hour counting sent + in-flight claims, ⌈per_hour / 6⌉ per tick, one batch per campaign per 5-minute slot across workers (`marketing_sweep_claims`), and `weekly_cap` (150) per 7 days. Each recipient is claimed `queued → sending` before its text; right before sending, every contact with the same number is re-checked (opt-out, cooldown, open booking/quote, bought again since the draft) and consent is enforced in deliverMessage. A claim older than 30 min is `failed`, never retried. Sent with `deliverMessage` from the company number, `sent_by = 'marketer'`. |
| Holds | Owner paused all texts (`ai_settings.owner_pause`), company paused/archived, win-back turned off, or no company number → nothing goes out (`held_since`, `hold_reason`; the owner is texted once for a missing number). The hold clears itself when the cause does. Held more than 3 days → cancelled and the owner told ("I cancelled the win-back campaign: it was on hold for 3 days…"), so an old seasonal text never resumes months later. |
| Replies | Come back to the company number; the SMS agent answers them (prompt note: treat it as an enquiry, never invent an offer). |
| Results | `campaignResults`: sent / skipped / failed / to go, replies, bookings and quotes from recipients within 30 days of their text. |

**Google reviews** (`reviews.ts`, `google.ts`): hourly sweep, once a day per company (claimed in `marketing_sweep_claims`, local 09:00–20:00), Places API (New) `GET /v1/places/{id}` with field mask `reviews,rating,userRatingCount,googleMapsUri` (`GOOGLE_PLACES_API_KEY`; ≤ 5 reviews). Refreshes `companies.google_rating` / `google_review_count`. Each new review (unique `company_id, review_name`) published in the last 30 days (and any left at `new` by a crash) gets a Claude reply draft (warm, specific, never argues, no refunds/discounts/private details; fenced as data; fallback template) and a `review_reply` approval (72h). On Y: `postReply` seam (no GBP API yet → returns not posted) → the owner is texted the reply + the review's Google link (claimed with `owner_texted_at`). Google content (text, author, rating, link, publish time) is nulled 30 days after it was fetched, for every company whatever its settings; older reviews on a first fetch are recorded with no content at all. Long-term we keep only the review's resource name (so it's never drafted twice) and our own reply + status.

**Google posts** (`posts.ts`): Monday 09:00–17:00 local (Tuesday catch-up), one `google_post_drafts` row per company per week, rotating service spotlight → seasonal tip → recent-job highlight (job title only, no names/addresses; falls back to a tip). Same copy checks. `google_post` approval (72h); Y texts the owner the copy + the GBP link.

**Settings** — `marketerActiveFor(admin, { organizationId, companyId })` (settings.ts) says whether the Marketer works for a company (any feature on, company active). `companies.ai_settings.marketing = { win_back: { enabled, months_min, months_max, weekly_cap, per_hour, start_hour, end_hour, days }, review_replies: { enabled }, google_posts: { enabled } }`, read only by `staff/marketer/settings.ts` (`readMarketingSettings`). Every feature defaults **on for CrankLeads orgs, off for house orgs** (A1) unless turned on. Route `GET|PATCH /api/organizations/:org/companies/:company/ai-settings/marketing` (members read; owners/admins PATCH `{ winBack: { enabled, monthsMin, monthsMax, weeklyCap }, reviewReplies: { enabled }, googlePosts: { enabled } }`, merging only `marketing`; the send throttle isn't owner-editable). UI: `src/components/settings/staff/MarketerSettingsSection.tsx`.

**Schema** — `marketing_campaigns`, `marketing_campaign_recipients` (unique `campaign_id, contact_id`), `google_reviews`, `google_post_drafts` (members read, service role writes), `marketing_sweep_claims` (service role only). Local types in `staff/marketer/db-types.ts`.

**Env** — `AI_MODEL_MARKETER` (default `claude-sonnet-5-5`), `GOOGLE_PLACES_API_KEY` (already set for done-for-you), `ANTHROPIC_API_KEY` (without it every draft uses the plain templates).

**Not yet** — no Google Business Profile API: replies and posts are pasted by the owner (`postReply` is the seam). The Places API only returns 5 "most relevant" reviews and doesn't say whether the owner already replied, so a recent review the owner answered on Google may still get a draft (they can N it). Seasonal / custom campaign kinds exist in the schema but only win-back is drafted. The campaign send window and rate aren't editable in the UI.

Tests: `src/test/marketer.test.ts`, `marketer-consent.test.ts`, `marketer-route.test.ts`.
