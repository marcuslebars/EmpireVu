# Tenant-scoped Stripe

How a tenant gets its own Stripe account for taking customer payments, and what
onboarding the next one requires.

## The two Stripe relationships

They are unrelated and must never be conflated. Money landing in the wrong one is
painful to unwind.

| | Platform billing (Phase 1) | Merchant payments (Phase 3+) |
|---|---|---|
| Who charges whom | EmpireVu charges an org for its subscription | A brand charges **its own** customers for deposits and balances |
| Account | EmpireVu's own Stripe account | The brand's account |
| Credentials | Global env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Per-company env refs (below) |
| Client | `billing/stripe.ts` → `getStripeClient()` | `quotes/company-stripe.ts` → `getCompanyStripeClient(companyId)` |
| Webhook | `/api/webhooks/stripe` | `/api/webhooks/stripe/merchant/{companyId}` |
| Column | `organizations.stripe_customer_id` (the org **as our customer**) | `companies.stripe_*_ref` (the company **as a merchant**) |

**The quotes path reads no global Stripe env var.** There is no fallback to the
platform key: an unconfigured company raises `CompanyStripeError` and the
checkout fails loudly. That is deliberate — a silent fallback would charge a
customer into EmpireVu's account.

## Why the company, not the organization

The tenant unit for Stripe is the **company**. In this schema `a1-group` is the
organization and A1 Marine Storage / Marine Care / Coatings / Boatnames are
companies inside it (`lead-intake/routing.ts`). Scoping at the organization would
give the whole family one indivisible Stripe identity — no way to give one brand
its own account, its own statement descriptor, or its own payout schedule.

A company always knows its organization, so this is strictly finer-grained than
org scoping, never coarser. If a tenant ever *is* one company, the two are
identical in practice.

Companies **may share** an account (the A1 brands do today). What keeps them
apart is the statement descriptor suffix and the per-company customer mapping.

## Where the secrets live

The `*_ref` columns hold the **name of a Railway env var**, never a secret.

- Live keys in Postgres would sit in every backup, replica and dump, readable by
  anything with DB access.
- The repo's standing rule is that secrets live server-side in Railway.
- Rotation becomes one Railway change instead of a DB write.

Resolution stays fully per-tenant: the company row decides *which* var is read.

### The allowlist is a real control, not decoration

Refs must match `^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$`, enforced in **both** the DB
(check constraint) and the app (`MERCHANT_ENV_PATTERN`).

Company settings are admin-editable, so the ref is attacker-influenced input.
Without the allowlist, `readMerchantEnv` is an arbitrary environment reader — a
crafted row naming `SUPABASE_SERVICE_ROLE_KEY` or the platform
`STRIPE_SECRET_KEY` would be honoured. Tests assert both of those names are
refused.

## Schema

On `companies`:

| Column | Purpose |
|---|---|
| `stripe_account_label` | Human label, e.g. `A1 Marine Storage (live)`. Never a secret. |
| `stripe_account_id` | `acct_…`, for reconciliation. Indexed, **not** unique — sharing is supported. |
| `stripe_secret_key_ref` | Env var name holding the secret key |
| `stripe_webhook_secret_ref` | Env var name holding the webhook signing secret |
| `stripe_publishable_key_ref` | Env var name holding the publishable key (unused until a client-side surface exists) |
| `stripe_mode` | `test` \| `live` — shown in admin without dereferencing a secret |
| `stripe_statement_descriptor_suffix` | What the cardholder reads |

Plus `company_stripe_customers (company_id, contact_id) → stripe_customer_id`.

## Onboarding a new tenant

1. **Create the Stripe account.** Activate it, set branding, set a **short**
   statement descriptor prefix, and complete the tax registration for the
   jurisdiction. `automatic_tax` fails the session without an active
   registration.
2. **Add the Railway env vars** on the **web** service, named
   `STRIPE_MERCHANT_<TENANT>_SECRET_KEY` and
   `STRIPE_MERCHANT_<TENANT>_WEBHOOK_SECRET`. Both must match the allowlist
   pattern.
3. **Point the company row at them:**

   ```sql
   update public.companies set
     stripe_account_label               = 'Acme (test)',
     stripe_account_id                  = 'acct_xxx',
     stripe_secret_key_ref              = 'STRIPE_MERCHANT_ACME_SECRET_KEY',
     stripe_webhook_secret_ref          = 'STRIPE_MERCHANT_ACME_WEBHOOK_SECRET',
     stripe_mode                        = 'test',
     stripe_statement_descriptor_suffix = 'ACME'
   where slug = 'acme';
   ```

4. **Register the webhook** in that Stripe account at
   `https://api.empirevu.com/api/webhooks/stripe/merchant/<company_id>` with
   `checkout.session.completed` and `invoice.paid`.

   The host must be the one that actually serves the app — see
   `docs/go-live-phase-1.md` 3b. The path is host-agnostic (inbound webhooks do
   not care which domain fronts the service), but a webhook pointed at a host
   that does not resolve fails silently as missed payments, not as an error.
5. **Verify** with the one-dollar runbook before enabling the flag.

## Statement descriptors

Stripe appends the suffix to the **account's** static prefix, and the combined
string is capped at **22 characters** — a long prefix leaves no room to tell
brands apart, so keep the prefix short.

Stripe rejects a charge outright on a malformed descriptor, so
`sanitizeStatementDescriptorSuffix` strips the forbidden characters
(`< > \ " ' *`), collapses whitespace, caps length, and requires at least one
letter. It returns `null` rather than something broken, and the caller then omits
the field so the account default applies. A stray character in a brand name must
never fail a customer's payment.

## Webhook routing and verification

The company id is in the **path**, so the tenant is known *before* the signature
is checked and exactly one secret is tried. No guessing, no
try-each-secret-in-turn, and one tenant's signing secret can never validate
another's payload. Nothing in the payload is trusted before verification.

Because sibling brands may share an account, a valid signature proves only that
the event came from **that account** — not which brand it belongs to. Sessions
therefore carry `company_id` in metadata and the route cross-checks it against
the path.

A missing or unreadable env ref returns **500, not 400**, so Stripe retries once
the operator fixes it rather than silently dropping a real payment.

## Idempotency

Stripe event ids are unique **per account**, so anything keyed on event id alone
would collide once tenants have separate accounts.

- The deposit handler is idempotent on the **quote**, guarded by the UPDATE's
  `WHERE` clause (`.is('deposit_paid_at', null)`), not a read-then-write. A
  redelivered event is a no-op.
- Phase 1's `billing_events` ledger is keyed on event id, but
  `recordBillingEvent` is called **only** from the platform webhook route, so
  that table only ever sees one account's ids. It is not shared with merchant
  events.

## Customer-facing branding

EmpireVu is the backend. A customer approving a quote or reading a deposit
receipt sees the **brand they hired**, never the platform running it. Nothing on
the hosted quote page, in the quote emails, or on the card statement may carry
EmpireVu branding.

Branding lives on the **company**, next to the Stripe credentials and voice
profiles: `companies.brand_logo_url`, `brand_primary_color`,
`brand_accent_color`, `brand_from_name`, `brand_reply_email`,
`brand_reply_phone`, `brand_website_url`, `quote_terms_text`,
`cancellation_policy_text`.

There is deliberately **no platform fallback**. A company with nothing configured
renders neutral — plain text on a default palette — rather than anything
platform-shaped. `quote-branding.test.ts` asserts this.

Two constraints are security, not cosmetics: colors must match `^#[0-9A-Fa-f]{6}$`
and logo/website must be absolute `https://`. Both values are interpolated into
the page (a style attribute and a `src`/`href`), and company settings are
admin-editable, so the check constraints keep `javascript:` and `data:` URIs and
style injection out.

One thing that is NOT per-company: the email **sending address**. It stays a
verified Resend domain set in env, because an arbitrary per-company From address
would fail SPF/DKIM and land the mail in spam. `brand_from_name` sets the display
name, which is what a recipient actually reads.

## Pricing

All quote line items are dynamic `price_data` computed by `@a1/pricing-engine` at
checkout time. **No code path reads Stripe Products or Prices for quote
pricing**, and none should be added — the engine is the single source of truth.
