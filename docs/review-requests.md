# Review requests

After a job, each customer gets one friendly text or email asking for a review. The link
goes through a short tracked link on the brand's own domain (`/r/{token}`) that forwards
to the brand's review page, so the owner can see who was asked and who clicked.

## Setting it up (Settings → Reviews, owners/admins)

- **Review link**: the brand's Google Business Profile "Ask for reviews" link (Facebook,
  HomeStars, Yelp… also work). Stored in `companies.brand_review_url`, which the
  `{{company.review_url}}` automation token already reads.
- **Ask every customer automatically**: on/off. It can't be switched on without a link.
- **Ask when**: a job is marked done (default), or the invoice is paid.
- **Send it**: right away, 1/2 (default)/4 hours later, the next day, 2 or 3 days later.
- **By**: text, or email if there's no mobile number (default); texts only; emails only.
- **How often**: at most every 3 months per customer by default (or monthly, 6 months,
  yearly, or after every job), so regulars aren't asked after every visit.
- **Messages**: text (≤ 320 characters) and email, with `{{first_name}}`, `{{company}}`
  and `{{link}}` (required). A live preview shows the real link domain.
- If the older "Review request" or "Thank-you + review ask when paid" automations are
  active, the screen warns that customers would be asked twice and offers to pause them.

Settings live in `companies.review_settings` (jsonb, defaulted in code, so new options
never need a migration).

## What happens

1. **Queued.** When a job moves to *completed* (any path: My Jobs, calendar, mobile, an
   automation) or an invoice becomes *paid* (staff payment or Stripe), one
   `review_requests` row is queued for `event + delay`, moved into **sending hours
   (9am–8pm, the brand's time zone)**. Only one ask per job / per invoice, and only one
   queued ask per customer at a time. Queuing never fails the job or the payment.
2. **Sent.** The worker checks every 5 minutes. Right before sending it re-checks:
   still switched on (else *cancelled*), link still set, job still done / invoice still
   paid, customer not asked inside the cooldown, still inside sending hours (else it
   waits for 9am). Then text first, email as the fallback (per the setting). Opt-outs
   always win. The completed job or payment counts as the existing business relationship
   for consent (CASL implied consent); the first text carries the usual STOP footer.
3. **At most once.** A row is claimed (*scheduled → sending*) before anything is sent,
   so two workers or a worker and a click can't double-text. A row interrupted mid-send
   is marked *failed* and never retried.
4. **Clicked.** `/r/{token}` counts a click (once per open; link-preview bots and HEAD
   requests aren't counted) and redirects to the review link. Unknown tokens get a plain
   page with no branding. "Clicked" means the customer opened the link; the review sites
   don't tell us whether a review was left.

Staff can also **ask by hand** from a contact's page (text or email, right away, any
hour). It warns if the customer was asked inside the cooldown ("Ask again anyway?"), and
it replaces any automatic ask still waiting. A queued ask can be stopped on the Reviews
page ("Don't send").

## Reviews page (`/reviews`)

Asked / clicked (with click rate) / queued / not sent for the last 30, 90 or 365 days,
and every request with its customer, job, status and reason. Filters: all, queued,
sent, not sent.

## Code

- `services/reviews/rules.ts`: pure (settings + defaults, sending hours, templates, the
  send decision). Tested in `src/test/review-requests.test.ts`.
- `services/reviews/service.ts`: staff side under RLS (settings, queueing, list, cancel,
  ask now).
- `services/reviews/send.ts`: **service role**, the sweep and the manual send; each row
  pinned to its own org/company/contact.
- `services/reviews/click.ts` + `src/app/r/[token]/route.ts`: **service role**, the
  public redirect via the security-definer `record_review_click`. `/r/` is excluded from
  the SPA rewrite in `next.config.mjs` (dynamic routes match after `afterFiles` rewrites).
- Hooks: `bookings.ts` (job completed), `invoices/common.ts` `onInvoicePaid`, the worker
  scheduler (every 5 min).
- API: `GET/PUT /api/organizations/{org}/review-settings/{company}`,
  `GET /review-requests`, `POST /review-requests/{id}/cancel`,
  `GET/POST /contacts/{contact}/review-request`.
- The monthly scorecard counts these asks in "review requests" and no longer suggests the
  old recipe when they're on.

Migration: `20261005120000_review_requests.sql` (rollback in `supabase/rollback/`).
