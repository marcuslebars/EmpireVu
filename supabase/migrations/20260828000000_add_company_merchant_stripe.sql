-- Tenant-scoped Stripe: merchant credentials, statement identity, and the
-- contact-to-Stripe-Customer mapping all resolve per tenant.
--
-- SCOPE: the tenant unit here is the COMPANY, not the organization.
-- `a1-group` is the organization; A1 Marine Storage / Marine Care / Coatings /
-- Boatnames are companies inside it (see lead-intake/routing.ts). Scoping at the
-- organization would give the whole family one indivisible Stripe identity, with
-- no way to give A1 Marine Storage its own account or its own statement
-- descriptor. Companies are also where per-brand config already lives
-- (company_voice_profiles). A company always knows its organization, so this is
-- strictly finer-grained than org scoping, never coarser.
--
-- Sharing is supported: two companies may name the same account and the same env
-- refs. What distinguishes them is the statement descriptor suffix and the
-- per-company customer mapping below.
--
-- TWO UNRELATED STRIPE RELATIONSHIPS, kept deliberately apart:
--
--   organizations.stripe_customer_id   the ORG AS TILOTTO'S CUSTOMER. Platform
--                                      billing (Phase 1) — the org's subscription
--                                      to us, on Tilotto's own account and its
--                                      global env keys. NOT TOUCHED by any of
--                                      this.
--
--   companies.stripe_*_ref             the COMPANY AS A MERCHANT. Its own Stripe
--                                      account, charging ITS customers for quote
--                                      deposits and balances.
--
-- WHERE THE SECRETS LIVE
-- The *_ref columns hold the NAME of the Railway env var holding each secret —
-- never the secret itself. Rationale:
--   • live Stripe keys in Postgres would sit in every backup, replica and dump,
--     readable by anything with DB access;
--   • the repo's standing rule is that secrets live server-side in Railway;
--   • rotation is then one Railway change, not a DB write.
-- Resolution stays fully per-tenant: the company row decides WHICH var is read.
--
-- The refs are constrained to a STRIPE_MERCHANT_ prefix. Company settings are
-- admin-editable, so without this a crafted row could name any variable in the
-- process environment (SUPABASE_SERVICE_ROLE_KEY, or the platform
-- STRIPE_SECRET_KEY) and have the resolver read it. The application enforces the
-- same pattern; this is the second lock.

alter table public.companies add column if not exists stripe_account_label text;
alter table public.companies add column if not exists stripe_account_id text;
alter table public.companies add column if not exists stripe_secret_key_ref text;
alter table public.companies add column if not exists stripe_webhook_secret_ref text;
-- Publishable keys are not secret, but the reference pattern is kept uniform so
-- there is one place to look. Unused until a client-side Stripe surface exists.
alter table public.companies add column if not exists stripe_publishable_key_ref text;
alter table public.companies add column if not exists stripe_mode text;
alter table public.companies add column if not exists stripe_statement_descriptor_suffix text;

alter table public.companies drop constraint if exists companies_stripe_mode_check;
alter table public.companies add constraint companies_stripe_mode_check
  check (stripe_mode is null or stripe_mode in ('test', 'live'));

alter table public.companies drop constraint if exists companies_stripe_secret_ref_check;
alter table public.companies add constraint companies_stripe_secret_ref_check
  check (stripe_secret_key_ref is null or stripe_secret_key_ref ~ '^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$');

alter table public.companies drop constraint if exists companies_stripe_hook_ref_check;
alter table public.companies add constraint companies_stripe_hook_ref_check
  check (stripe_webhook_secret_ref is null or stripe_webhook_secret_ref ~ '^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$');

alter table public.companies drop constraint if exists companies_stripe_pub_ref_check;
alter table public.companies add constraint companies_stripe_pub_ref_check
  check (stripe_publishable_key_ref is null or stripe_publishable_key_ref ~ '^STRIPE_MERCHANT_[A-Z0-9_]{1,60}$');

-- Brands MAY share one account, so this is an index, not a unique index. What
-- keeps them apart on a shared account is the statement descriptor suffix: it is
-- what the cardholder actually reads.
create index if not exists companies_stripe_account_idx
  on public.companies (stripe_account_id)
  where stripe_account_id is not null;

-- Stripe caps the ACCOUNT prefix + this suffix at 22 characters combined, rejects
-- < > backslash " ' and *, and requires at least one letter. The application
-- sanitises too; a malformed descriptor makes Stripe refuse the charge outright.
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
-- Contact -> Stripe Customer, scoped to the merchant account.
--
-- Stripe Customers belong to ONE account, so a contact quoted by two brands on
-- two accounts legitimately holds two different customer ids. Keying this by
-- (company_id, contact_id) makes that representable and collision-free.
--
-- It also fixes a real defect in the pre-existing shape, where the mapping lived
-- on the quote: a repeat customer got a brand-new Stripe Customer on every quote,
-- scattering their saved cards and payment history across duplicates. Phase 4
-- charges the balance off-session against the saved card, so that mattered.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.company_stripe_customers (
  company_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id uuid not null,
  stripe_customer_id text not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (company_id, contact_id),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete cascade
);

-- One Stripe Customer maps back to one contact within a company.
create unique index if not exists company_stripe_customers_customer_uniq
  on public.company_stripe_customers (company_id, stripe_customer_id);

create index if not exists company_stripe_customers_org_idx
  on public.company_stripe_customers (organization_id);

alter table public.company_stripe_customers enable row level security;

-- Read-only to org members; the payment path writes via the service role.
drop policy if exists "company_stripe_customers_org_members_select" on public.company_stripe_customers;
create policy "company_stripe_customers_org_members_select" on public.company_stripe_customers
  for select using (public.is_organization_member(organization_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- Cleanup: earlier revisions of THIS migration put these columns on
-- organizations, then on companies under stripe_merchant_* names. Neither was
-- merged or populated, so dropping them is safe; this exists only so a database
-- that ran an earlier revision converges on the same shape rather than keeping
-- dead columns that could be wired up by mistake later.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.organizations drop constraint if exists organizations_stripe_merchant_mode_check;
alter table public.organizations drop constraint if exists organizations_stripe_merchant_key_env_check;
alter table public.organizations drop constraint if exists organizations_stripe_merchant_hook_env_check;
drop index if exists public.organizations_stripe_merchant_account_uniq;
alter table public.organizations drop column if exists stripe_merchant_account_id;
alter table public.organizations drop column if exists stripe_merchant_secret_key_env;
alter table public.organizations drop column if exists stripe_merchant_webhook_secret_env;
alter table public.organizations drop column if exists stripe_merchant_mode;

alter table public.companies drop constraint if exists companies_stripe_merchant_mode_check;
alter table public.companies drop constraint if exists companies_stripe_merchant_key_env_check;
alter table public.companies drop constraint if exists companies_stripe_merchant_hook_env_check;
drop index if exists public.companies_stripe_merchant_account_idx;
alter table public.companies drop column if exists stripe_merchant_account_id;
alter table public.companies drop column if exists stripe_merchant_secret_key_env;
alter table public.companies drop column if exists stripe_merchant_webhook_secret_env;
alter table public.companies drop column if exists stripe_merchant_mode;
