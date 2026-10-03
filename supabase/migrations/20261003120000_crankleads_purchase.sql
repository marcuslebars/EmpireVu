-- CrankLeads purchase → automatic EmpireVu account (docs/crankleads-purchase.md).
--
-- A business buys a CrankLeads tier on crankleads.com: the public checkout endpoint
-- (POST /api/public/crankleads/checkout) stages a crankleads_purchases row and opens a
-- Stripe Checkout session; when Stripe reports the session paid, the billing worker
-- provisions the owner login + organization + company from that row, exactly once.
--
-- Additive only. Rollback: supabase/rollback/20261003120000_crankleads_purchase.down.sql.

-- ── organizations.crankleads_tier ───────────────────────────────────────────
-- Which CrankLeads offer the org bought (null = not a CrankLeads purchase). Informational
-- for the app, support and the scorecard; feature access still comes from organizations.plan
-- (catch/close → operate, front_desk → front_desk — src/server/services/crankleads/config.ts).
alter table public.organizations
  add column if not exists crankleads_tier text;

alter table public.organizations
  drop constraint if exists organizations_crankleads_tier_check;
alter table public.organizations
  add constraint organizations_crankleads_tier_check
    check (crankleads_tier is null or crankleads_tier in ('catch', 'close', 'front_desk'));

-- ── crankleads_purchases (staging + provisioning state machine) ─────────────
-- TENANCY EXCEPTION (convention #1): this table is written BEFORE any organization exists —
-- the buyer has no account yet when they submit the crankleads.com form — so it cannot
-- carry a NOT NULL organization_id. organization_id / company_id are filled in by
-- provisioning once the org exists. It is service-role only: RLS is enabled with NO
-- policies and anon/authenticated have no grants, so no tenant (and no anonymous visitor)
-- can read buyer details. Written by the public checkout endpoint and the billing worker
-- (both SANCTIONED EXCEPTIONS, listed in docs/EMPIREVU_RUNBOOK.md).
--
-- Status machine: checkout_created → paid → provisioning → provisioned | failed
-- (failed → provisioning again on an automatic retry or `npm run job:crankleads-provision`).
-- The unique Checkout Session id makes provisioning exactly-once per purchase.
create table if not exists public.crankleads_purchases (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'checkout_created'
    check (status in ('checkout_created', 'paid', 'provisioning', 'provisioned', 'failed')),
  tier text not null check (tier in ('catch', 'close', 'front_desk')),
  stripe_checkout_session_id text unique,
  stripe_customer_id text,
  stripe_subscription_id text,
  owner_name text not null check (char_length(owner_name) <= 200),
  owner_email citext not null check (char_length(owner_email) <= 320),
  owner_phone text not null check (char_length(owner_phone) <= 40),
  business_name text not null check (char_length(business_name) <= 200),
  business_type text not null check (char_length(business_type) <= 100),
  founding boolean not null default false,
  utm jsonb not null default '{}'::jsonb,
  organization_id uuid references public.organizations (id) on delete set null,
  company_id uuid references public.companies (id) on delete set null,
  owner_profile_id uuid references public.profiles (id) on delete set null,
  existing_user boolean,
  provision_attempts integer not null default 0 check (provision_attempts >= 0),
  last_error text,
  paid_at timestamptz,
  provisioning_started_at timestamptz,
  provisioned_at timestamptz,
  failed_at timestamptz,
  welcome_email_sent_at timestamptz,
  welcome_email_error text,
  operator_notified_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists crankleads_purchases_customer_idx
  on public.crankleads_purchases (stripe_customer_id)
  where stripe_customer_id is not null;
create index if not exists crankleads_purchases_status_idx
  on public.crankleads_purchases (status, created_at desc);

drop trigger if exists crankleads_purchases_set_updated_at on public.crankleads_purchases;
create trigger crankleads_purchases_set_updated_at
before update on public.crankleads_purchases
for each row execute procedure public.touch_updated_at();

alter table public.crankleads_purchases enable row level security;
-- No policies on purpose: service role only (it bypasses RLS).
revoke all on public.crankleads_purchases from anon, authenticated;
