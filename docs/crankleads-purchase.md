# CrankLeads purchase → automatic EmpireVu account

When a business buys a CrankLeads tier on **crankleads.com**, everything is set up
automatically: they pay first, and on payment EmpireVu creates their login, organization,
company, starter pack, automations and website form, then emails them a set-password link.
They log in to **EmpireVu** (app.empirevu.com) — EmpireVu keeps its own branding; CrankLeads
is only named where the buyer needs context (the welcome email and the welcome page).

The phone number is **not** bought at purchase time: the owner picks it in the setup wizard's
Phone step (Catch / Close: missed-call catcher only; Front Desk: AI receptionist or catcher).

| Tier | EmpireVu plan | Stripe (CAD, set by the setup script) | Starter automations |
|---|---|---|---|
| `catch` | `operate` | setup fee + monthly | missed-call text-back, new-lead owner alert, booking reminder, customer-reply forwarding |
| `close` | `operate` | setup fee + monthly | every pack automation except the AI-receptionist ones |
| `front_desk` | `front_desk` (500 AI minutes) | setup fee + monthly | every pack automation |

Catch runs on `operate`, not `launch`, because the missed-call text-back and instant replies
need workflows + SMS. Prices live **only in Stripe** (Working Protocol #4) — code references
them by Price id from env. Mapping: `src/server/services/crankleads/config.ts`.

## Flow

```mermaid
sequenceDiagram
  participant B as Buyer (crankleads.com)
  participant W as EmpireVu web
  participant S as Stripe
  participant Q as billing_events / billing_event_jobs
  participant BW as billing worker
  participant E as Resend
  B->>W: POST /api/public/crankleads/checkout {tier, name, email, phone, businessName, businessType}
  W->>W: zod + CORS + rate limit → INSERT crankleads_purchases (checkout_created)
  W->>S: Checkout Session (subscription: monthly + one-time setup, CAD)
  W-->>B: { url }
  B->>S: pays (test card 4242 4242 4242 4242)
  S-->>B: redirect /welcome/crankleads?session_id=cs_…
  S->>W: webhook checkout.session.completed (+ invoice.paid, customer.subscription.created)
  W->>Q: record_billing_event (durable, idempotent)
  BW->>Q: claim job
  BW->>BW: purchase paid → provisioning (claim) → user, org, company, pack, form, onboarding steps
  BW->>E: welcome email (set-password link) + operator note
  BW->>Q: re-queue any subscription/invoice events that were waiting
  B->>W: welcome page polls GET /api/public/crankleads/checkout/{sessionId} → "Done! check your email"
```

**Status machine** (`crankleads_purchases.status`): `checkout_created → paid → provisioning →
provisioned | failed`. The Checkout Session id is unique, the `provisioning` claim is
status-guarded (optimistic), and every step is idempotent (org found again by its unique
`stripe_customer_id`, company/user/form key re-used), so a session is provisioned **exactly
once** no matter how often Stripe re-delivers or a worker crashes mid-way (a `provisioning`
claim older than 10 minutes is re-claimable).

What provisioning does (`src/server/services/crankleads/provision.ts`), in order:

1. **Login** — Supabase admin `createUser` (email confirmed). If the email already belongs to an
   EmpireVu user, the new org is attached to them instead and they get a "log in" email (no
   password link).
2. **Organization** — `createOrganization` (the signup service) with the tier's plan,
   `subscription_status = active`, the Stripe customer, `crankleads_tier`; owner membership.
3. **Company** — `createCompany` (the wizard's Business-step service — installs the recipe
   catalog), then owner email, E.164 owner phone, timezone `America/Toronto`.
4. **Industry pack** for the business type (Property maintenance & snow → `property-maintenance-snow`,
   Landscaping → `landscaping`, Roofing → `roofing`, HVAC & plumbing → `hvac-plumbing`,
   Contracting & renovation → `general-contractor`, Marine → `marine`; Auto detailing,
   Cleaning, Other → no pack) via `applyIndustryPack`, with the tier's automations.
5. **Website form key** (`public_form_keys`) — the hosted link `/f/evpk_…` works immediately.
6. **Onboarding** — `business` (and `services` when a pack applied) marked complete, so
   `/onboarding` resumes at the right step. Left for the owner: prices, phone, website snippet + test.
7. **Emails** — buyer: *"Your CrankLeads system is ready — finish setup (10 min)"* with what's
   done, the set-password link, the hosted form link and the 3 remaining steps. Operator
   (`OWNER_EMAIL`): *"New CrankLeads purchase: <business> (<tier>)"*. An email failure never
   fails provisioning — it's recorded (`welcome_email_error`) and flagged in the operator note.

**Set-password link.** The admin `generateLink({type: "recovery"})` hashed token is sent as
`/update-password?token_hash=…&type=recovery&next=/onboarding`; the page verifies it with
`verifyOtp` (the SPA's Supabase client uses PKCE, so the raw `action_link` — an implicit-flow
redirect — would be rejected). The link is one-time and expires with the project's email OTP
expiry (Supabase default 1 hour — raise it to 24 h in Auth settings if you like); the buyer can
always use **Forgot password** or the welcome page's **Resend** button.

**Events that race ahead.** `invoice.paid` / `customer.subscription.created|updated` can be
processed before provisioning finishes. When their customer is unknown **and** a CrankLeads
purchase for it (by `metadata.purchaseId` or customer id) is still `checkout_created / paid /
provisioning`, the job is re-queued with backoff (30 s, 60 s, 120 s, 240 s; bounded by
`max_attempts = 5`) instead of dead-lettering. When provisioning finishes it pulls those jobs
forward (and re-queues any that already dead-lettered), so they resolve to the new org. Unknown
non-CrankLeads customers still dead-letter exactly as before.

**Failures.** A provisioning error marks the purchase `failed` with `last_error` and is retried
automatically by the queue; on the last attempt the operator gets *"ACTION NEEDED: CrankLeads
provisioning failed"* and the job dead-letters. The payment and the purchase row are never lost.

## API

### `POST /api/public/crankleads/checkout` (public, CORS)

Request (JSON, ≤ 8 KB):

```json
{
  "tier": "catch | close | front_desk",
  "name": "Jane Roofer",
  "email": "jane@example.com",
  "phone": "(705) 555-0101",
  "businessName": "Jane's Roofing",
  "businessType": "Roofing",
  "founding": true,
  "utm": { "utm_source": "google" }
}
```

`founding` and `utm` are optional. `phone` needs ≥ 10 digits. `businessType` is free text
(≤ 100 chars) — the site's options map to packs as listed above; anything else is generic.

| Status | Body |
|---|---|
| 200 | `{ "url": "https://checkout.stripe.com/…" }` — redirect the browser there |
| 400 | `{ "error": "Please check the highlighted fields.", "fields": { "email": "Invalid email" } }` (or `{ "error": "Invalid JSON." }`) |
| 403 | `{ "error": "Origin not allowed." }` — browser Origin not in `CRANKLEADS_SITE_ORIGINS` |
| 413 | `{ "error": "Request too large." }` |
| 429 | `{ "error": "Too many requests…" }` — 10 / 10 min per IP, 5 / hour per email |
| 503 | `{ "error": "Checkout is temporarily unavailable…" }` — the tier's Stripe prices aren't configured |
| 502 | `{ "error": "Couldn't start checkout. Please try again." }` — Stripe error |

CORS: `Access-Control-Allow-Origin` echoes an allow-listed origin only; no credentials. A
request with **no** Origin (a server-side call) is allowed.

Checkout Session: `mode: subscription`, line items = tier monthly price + tier setup price
(one-time prices ride on the first invoice only), `customer_email`, `client_reference_id` =
purchase id, `currency: cad`, `billing_address_collection: required`, `automatic_tax` off unless
`STRIPE_AUTOMATIC_TAX=true`, `discounts: [{coupon}]` when `founding` and
`STRIPE_COUPON_CL_FOUNDING` is set (else `allow_promotion_codes: true`), `metadata` and
`subscription_data.metadata` = `{source: "crankleads", purchaseId, tier, plan, businessName,
businessType, ownerName, ownerPhone, utm}` (utm JSON kept ≤ 500 chars),
`success_url = APP_BASE_URL/welcome/crankleads?session_id={CHECKOUT_SESSION_ID}`,
`cancel_url = CRANKLEADS_CANCEL_URL` (default `https://crankleads.com/#pricing`).

**Example (crankleads.com):**

```js
const res = await fetch("https://app.empirevu.com/api/public/crankleads/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tier, name, email, phone, businessName, businessType, founding, utm }),
});
const body = await res.json();
if (res.ok) window.location.href = body.url; else showErrors(body.fields ?? body.error);
```

### `GET /api/public/crankleads/checkout/{sessionId}` (public, same-origin)

`{ "data": { "status": "pending | provisioning | ready | failed", "businessName": "…", "emailMasked": "j***@example.com" } }`
— nothing else. 404 for an unknown or malformed id.

### `POST /api/public/crankleads/checkout/{sessionId}/resend`

Re-sends the welcome email (fresh set-password link) to the address that paid — never to an
address in the request. 3 / hour per session, 10 / hour per IP. 409 until provisioned.

## Setup checklist (Stripe TEST mode first)

1. **Apply the migration** in the Supabase SQL editor:
   `supabase/migrations/20261003120000_crankleads_purchase.sql`
   (verify: `select count(*) from crankleads_purchases;` → `0`).
2. **Create the Stripe catalog** (PowerShell, test key). Amounts are in **cents**:
   ```powershell
   $env:STRIPE_SECRET_KEY = "sk_test_..."
   npm run stripe:setup-crankleads -- --catch-setup 150000 --catch-monthly 50000 --close-setup 250000 --close-monthly 100000 --front-desk-setup 350000 --front-desk-monthly 150000 --founding-percent 50 --founding-max 5
   ```
   Add `--dry-run` first to see what it would create. It is idempotent (products by id
   `crankleads_<tier>` / `crankleads_<tier>_setup`, prices by lookup key
   `crankleads_<tier>_monthly` / `crankleads_<tier>_setup`, coupon `crankleads_founding_<percent>`),
   refuses a live key unless `--live`, and prints the env lines. Changing an amount later needs
   `--replace` (Stripe prices are immutable; the lookup key moves to the new price).
   Setup fees sit on their own `…_setup` products so the founding coupon (`duration: once`,
   `applies_to` the three setup products) discounts **only the setup fee**.
3. **Paste the env** the script prints into Railway:
   - **[web]**: `STRIPE_PRICE_CL_*`, `STRIPE_SETUP_FEE_CL_*`, optional `STRIPE_COUPON_CL_FOUNDING`,
     optional `CRANKLEADS_SITE_ORIGINS`, `CRANKLEADS_CANCEL_URL`, `STRIPE_AUTOMATIC_TAX`.
   - **[billing-worker]**: `STRIPE_PRICE_CL_*` **plus** (existing values, same as web)
     `APP_BASE_URL`, `RESEND_API_KEY`, `OUTBOUND_FROM_EMAIL` (opt. `OUTBOUND_REPLY_TO`),
     `OWNER_EMAIL`, and `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` (only so
     the SMS starter automations install **active** — the worker never sends SMS).
   - **[reconcile]**: `STRIPE_PRICE_CL_*` (plan-drift check).
4. **Stripe webhook** (Dashboard → Developers → Webhooks → the `/api/webhooks/stripe` endpoint):
   make sure it sends `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
5. **Deploy** web + billing worker (the billing worker now does the provisioning).
6. **HST**: automatic tax is OFF. Either register for Stripe Tax (Ontario HST) and set
   `STRIPE_AUTOMATIC_TAX=true` on [web] (prices are created `tax_behavior: exclusive`, so HST is
   added on top), or invoice HST manually.

## End-to-end test (test card)

1. From crankleads.com (or PowerShell):
   ```powershell
   $body = @{ tier = "catch"; name = "Test Owner"; email = "you+cl1@yourdomain.com"; phone = "705 555 0101"; businessName = "Test Roofing"; businessType = "Roofing" } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "https://app.empirevu.com/api/public/crankleads/checkout" -ContentType "application/json" -Body $body
   ```
   Open the returned `url`.
2. Pay with **4242 4242 4242 4242**, any future expiry, any CVC, any Canadian postal code.
3. You land on `/welcome/crankleads?session_id=cs_test_…`: "Payment received — setting up your
   system…" then "Done! Check your email (y***@yourdomain.com)…" within a few seconds (billing
   worker poll interval).
4. The email *"Your CrankLeads system is ready — finish setup (10 min)"* arrives; the operator
   inbox gets *"New CrankLeads purchase: Test Roofing (Catch)"*.
5. Click **Set your password and log in to EmpireVu** → set a password → **Continue setup** →
   `/onboarding` resumes at **Phone** (Business + Services done). The Phone step offers only the
   missed-call catcher (Catch).
6. Check: Settings → Billing shows plan `operate`, status active; `organizations.crankleads_tier = 'catch'`;
   Settings → Industry pack shows Roofing; the hosted form link from the email opens.
7. Repeat with `front_desk` to see the AI receptionist offered on the Phone step.

## Re-running a failed provision

```powershell
npm run job:crankleads-provision -- --session cs_test_...
```

Run it from a machine with the production env (Supabase service role, Resend, `APP_BASE_URL`,
`OWNER_EMAIL`; plus `STRIPE_SECRET_KEY` if the purchase never got its webhook). It:
- provisions a `failed` / `paid` / stuck `provisioning` purchase (as the final attempt),
- for a `checkout_created` purchase (webhook never arrived) asks Stripe whether the session is
  paid and provisions it if so,
- for an already `provisioned` purchase just re-queues any billing events still waiting on it.

Find failed purchases: `select stripe_checkout_session_id, business_name, last_error from crankleads_purchases where status = 'failed';`

## Data

Migration `20261003120000_crankleads_purchase.sql` (rollback
`supabase/rollback/20261003120000_crankleads_purchase.down.sql`):

- `organizations.crankleads_tier` (`catch | close | front_desk`, nullable) — what the org
  bought; kept in step with portal tier changes by `customer.subscription.updated`.
- `crankleads_purchases` — staging + state machine. **Tenancy exception:** it is written before
  any organization exists, so `organization_id` is nullable (filled by provisioning). RLS is on
  with **no policies** and no grants to `anon`/`authenticated`: service role only.
