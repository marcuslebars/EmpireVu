-- Stripe Connect: tenants connect their OWN Stripe account, self-serve.
--
-- This replaces the per-tenant env-var pattern added days ago (stripe_secret_key_ref
-- and friends). That pattern worked for tenant zero but does not scale to a product:
-- every new tenant needed a Railway env var, a redeploy, and a hand-registered
-- webhook endpoint. Three ops actions per customer is not self-serve.
--
-- With Connect (Standard accounts, DIRECT charges):
--   • the platform holds ONE Stripe key; tenants never hand us a secret
--   • a tenant onboards itself through Stripe-hosted onboarding
--   • charges are created on the tenant's account via the Stripe-Account header,
--     so funds land in THEIR balance, refunds and chargebacks hit THEIR account,
--     and THEIR statement descriptor and tax registration apply
--   • Connect webhooks all arrive at ONE platform endpoint carrying an `account`
--     field, so there is nothing to register per tenant
--
-- Direct charges are the documented fit for "connected accounts transact directly
-- with their customers, who are often unaware of your platform's existence" —
-- which is precisely the branding rule this product already enforces.

alter table public.companies
  add column if not exists stripe_connected_account_id text;

-- Capability state, mirrored from account.updated webhooks so the app can tell an
-- operator WHY checkout is unavailable without a live API call on every request.
alter table public.companies
  add column if not exists stripe_charges_enabled boolean not null default false;
alter table public.companies
  add column if not exists stripe_payouts_enabled boolean not null default false;
alter table public.companies
  add column if not exists stripe_details_submitted boolean not null default false;
alter table public.companies
  add column if not exists stripe_connect_updated_at timestamptz;
-- Onboarding requirements Stripe is still waiting on, verbatim, for the admin UI.
alter table public.companies
  add column if not exists stripe_requirements jsonb;

-- One connected account per company, and one company per connected account.
-- Unlike the shared-key arrangement this replaces, sharing here would be a real
-- error: two companies pointing at one connected account would cross-post
-- payments into one balance with no way to tell them apart.
create unique index if not exists companies_stripe_connected_account_uniq
  on public.companies (stripe_connected_account_id)
  where stripe_connected_account_id is not null;

alter table public.companies drop constraint if exists companies_stripe_connected_account_check;
alter table public.companies add constraint companies_stripe_connected_account_check
  check (stripe_connected_account_id is null or stripe_connected_account_id ~ '^acct_[A-Za-z0-9]+$');

-- ─────────────────────────────────────────────────────────────────────────────
-- Retire the env-ref columns.
--
-- Safe to drop rather than deprecate: they were added days ago, are unused in
-- production (STRIPE_QUOTES_ENABLED has never been on), and leaving them would
-- invite someone to wire up a second, unreviewed credential path. The account
-- label, mode and statement descriptor stay — they are still meaningful, and the
-- descriptor is now sent on the connected account's charges.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.companies drop constraint if exists companies_stripe_secret_ref_check;
alter table public.companies drop constraint if exists companies_stripe_hook_ref_check;
alter table public.companies drop constraint if exists companies_stripe_pub_ref_check;

alter table public.companies drop column if exists stripe_secret_key_ref;
alter table public.companies drop column if exists stripe_webhook_secret_ref;
alter table public.companies drop column if exists stripe_publishable_key_ref;

-- stripe_account_id was the hand-entered acct_ id under the old scheme; the
-- connected account id supersedes it.
drop index if exists public.companies_stripe_account_idx;
alter table public.companies drop column if exists stripe_account_id;
