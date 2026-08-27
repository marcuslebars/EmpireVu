-- Per-brand Stripe: merchant credentials and statement identity resolve per
-- COMPANY.
--
-- Scoping note. In this schema a brand is a COMPANY, not an organization:
-- `a1-group` is the organization, and A1 Marine Storage / Marine Care / Coatings
-- / Boatnames are companies inside it (see lead-intake/routing.ts). Per-brand
-- config therefore belongs on companies — this matches company_voice_profiles,
-- which already lives here.
--
-- Sharing is expected, not exceptional: the A1 group companies all point at ONE
-- Stripe account today. Scoping per company is about being able to tell them
-- apart (statement descriptor, and later reporting), and about leaving room for a
-- brand to move onto its own account without a migration. Two brands naming the
-- same account is a supported configuration.
--
-- There are now TWO unrelated Stripe relationships, and conflating them would be
-- expensive, so the naming keeps them apart:
--
--   organizations.stripe_customer_id   the ORG AS TILOTTO'S CUSTOMER. Platform
--                                      billing (Phase 1) — the org's subscription
--                                      to us, on the PLATFORM account and its
--                                      global env keys. Untouched.
--
--   companies.stripe_merchant_*        the COMPANY AS A MERCHANT. Its own Stripe
--                                      account, charging ITS customers for quote
--                                      deposits and balances. Added here.
--
-- WHERE THE SECRETS LIVE
-- The secret key and webhook signing secret are NOT stored here. These columns
-- hold the NAME of the Railway env var holding each secret. Rationale:
--   • live Stripe keys in Postgres would sit in every backup, replica and dump,
--     readable by anything with DB access;
--   • the repo's standing rule is that secrets live server-side in Railway;
--   • rotation is then one Railway change, not a DB write.
-- Resolution is still fully per-brand: the company row decides WHICH var is read.
--
-- The names are constrained to a STRIPE_MERCHANT_ prefix. Company settings are
-- admin-editable, so without this a crafted row could name any variable in the
-- process environment (SUPABASE_SERVICE_ROLE_KEY, or the platform
-- STRIPE_SECRET_KEY) and have the resolver read it. The application enforces the
-- same pattern; this is the second lock.

alter table public.companies
  add column if not exists stripe_merchant_account_id text;

alter table public.companies
  add column if not exists stripe_merchant_secret_key_env text;

alter table public.companies
  add column if not exists stripe_merchant_webhook_secret_env text;

-- 'test' | 'live' — recorded so the admin UI can show which mode a brand is in
-- without dereferencing a secret.
alter table public.companies
  add column if not exists stripe_merchant_mode text;

alter table public.companies drop constraint if exists companies_stripe_merchant_mode_check;
alter table public.companies add constraint companies_stripe_merchant_mode_check
  check (stripe_merchant_mode is null or stripe_merchant_mode in ('test', 'live'));

alter table public.companies drop constraint if exists companies_stripe_merchant_key_env_check;
alter table public.companies add constraint companies_stripe_merchant_key_env_check
  check (
    stripe_merchant_secret_key_env is null or
    stripe_merchant_secret_key_env ~ '^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$'
  );

alter table public.companies drop constraint if exists companies_stripe_merchant_hook_env_check;
alter table public.companies add constraint companies_stripe_merchant_hook_env_check
  check (
    stripe_merchant_webhook_secret_env is null or
    stripe_merchant_webhook_secret_env ~ '^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$'
  );

-- Brands MAY share one merchant account (the A1 group companies do), so the
-- account id is deliberately NOT unique. What keeps them apart on a shared
-- account is the statement descriptor suffix below: it is what the cardholder
-- actually reads on their statement, and what makes "A1 STORAGE" distinguishable
-- from "A1 MARINE CARE" when both settle into the same Stripe balance.
create index if not exists companies_stripe_merchant_account_idx
  on public.companies (stripe_merchant_account_id)
  where stripe_merchant_account_id is not null;

-- Per-brand statement descriptor suffix.
--
-- Stripe appends this to the ACCOUNT's static descriptor prefix (set in the
-- Stripe dashboard), and the combined string is capped at 22 characters. Stripe
-- also rejects < > \ " ' *, and requires at least one letter. The check below
-- enforces the charset and a conservative length; the application sanitises too.
alter table public.companies
  add column if not exists stripe_statement_descriptor_suffix text;

alter table public.companies drop constraint if exists companies_statement_descriptor_check;
alter table public.companies add constraint companies_statement_descriptor_check
  check (
    stripe_statement_descriptor_suffix is null or (
      length(stripe_statement_descriptor_suffix) between 1 and 22 and
      stripe_statement_descriptor_suffix ~ '^[A-Za-z0-9 .,&()+/-]+$' and
      stripe_statement_descriptor_suffix ~ '[A-Za-z]'
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Cleanup: an earlier revision of THIS migration put these columns on
-- organizations. They were never populated and never merged to main, so dropping
-- them is safe; this exists only so a database that ran that revision converges
-- on the same shape, rather than keeping dead columns that could be wired up by
-- mistake later.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.organizations drop constraint if exists organizations_stripe_merchant_mode_check;
alter table public.organizations drop constraint if exists organizations_stripe_merchant_key_env_check;
alter table public.organizations drop constraint if exists organizations_stripe_merchant_hook_env_check;
drop index if exists public.organizations_stripe_merchant_account_uniq;

alter table public.organizations drop column if exists stripe_merchant_account_id;
alter table public.organizations drop column if exists stripe_merchant_secret_key_env;
alter table public.organizations drop column if exists stripe_merchant_webhook_secret_env;
alter table public.organizations drop column if exists stripe_merchant_mode;
