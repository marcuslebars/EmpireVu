-- Phase 4 AI staff: SERVICE PLANS, maintenance agreements and renewals
-- (docs/ai-staff.md → "Service plans").
--
--   1. service_plans: the plan templates the owner sells ("Spring + Fall Lawn Care, $420/yr,
--      visits in May and October, Tuesday mornings"). Billing is `annual` (one invoice per term,
--      paid up front) or `per_visit` (each visit invoiced like any recurring visit).
--   2. service_agreements: one customer on one plan for one term (12 months). Status
--      pending_owner → (pending_payment →) active → renewal_due → renewed / lapsed, or
--      cancelled. An active agreement drives ONE recurring_jobs series that this feature created
--      (recurring_job_id); a renewal is a new row for the next term pointing at the same series.
--   3. service_plan_messages: every customer text (confirmation, renewal link, visit heads-up),
--      unique per (company, kind, dedupe key) and claimed before it is sent, so overlapping
--      workers send each one once. Texts approved at night wait here (queued, not_before).
--   4. service_plan_runs: once-per-period claims for the sweeps (the weekly renewal batch).
--   5. recurring_jobs.visit_dates: an explicit list of visit dates. NULL (every existing series,
--      A1's included) keeps the rule-based generation exactly as before; a service-plan series
--      carries its plan's dates (e.g. the first Tuesday of May and of October) because the
--      weekly / monthly / yearly rule can't say "spring and fall".
--
-- Settings live in companies.ai_settings.service_plans (read in code, defaults there). House
-- orgs (platform_brand <> 'crankleads') are always off.
-- Additive and re-runnable. Nothing new is client-writable (see 20261006170000): every write is
-- the server's (service role).
-- Rollback: supabase/rollback/20261013110000_staff_service_plans.down.sql

-- ── 1. Plan templates ─────────────────────────────────────────────────────────────
create table if not exists public.service_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  name text not null check (char_length(name) between 1 and 80),
  description text check (description is null or char_length(description) <= 1000),
  -- annual: the price of one 12-month term; per_visit: the price of each visit. Before HST.
  price_cents integer not null check (price_cents between 100 and 10000000),
  billing text not null check (billing in ('annual', 'per_visit')),
  -- The visit months (1 = January … 12 = December), one visit per listed month per term.
  visit_months smallint[] not null check (cardinality(visit_months) between 1 and 12),
  -- Which day in each visit month: the Nth (week_of_month) <weekday> (0 = Sunday … 6 = Saturday).
  weekday smallint not null default 1 check (weekday between 0 and 6),
  week_of_month smallint not null default 1 check (week_of_month between 1 and 4),
  time_of_day text not null default '09:00' check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_minutes integer not null default 60 check (duration_minutes between 15 and 720),
  -- What every visit includes: ["Aerate the lawn", "Fertilize"].
  included jsonb not null default '[]'::jsonb check (jsonb_typeof(included) = 'array'),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists service_plans_company_idx on public.service_plans (company_id, active);

-- ── 2. Agreements ─────────────────────────────────────────────────────────────────
create table if not exists public.service_agreements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  plan_id uuid not null references public.service_plans(id) on delete restrict,
  contact_id uuid references public.contacts(id) on delete set null,
  status text not null default 'pending_owner'
    check (status in ('pending_owner', 'pending_payment', 'active', 'renewal_due', 'renewed', 'lapsed', 'cancelled')),
  -- How it started: the public plans page, the owner by text, Settings, or a renewal.
  source text not null default 'public' check (source in ('public', 'owner_text', 'settings', 'renewal')),
  -- Locked at sign-up: what the customer agreed to for this term.
  plan_name text not null check (char_length(plan_name) between 1 and 80),
  billing text not null check (billing in ('annual', 'per_visit')),
  price_cents integer not null check (price_cents between 100 and 10000000),
  visit_months smallint[] not null,
  -- The term: term_start .. term_end inclusive (12 months), set when the agreement starts.
  term_start date,
  term_end date,
  -- The visit dates of this term (YYYY-MM-DD), laid out from the plan's schedule.
  visit_dates date[] not null default '{}'::date[],
  -- The recurring_jobs series THIS feature created for the customer (never anyone else's).
  recurring_job_id uuid references public.recurring_jobs(id) on delete set null,
  -- Every invoice for this term (annual: the term invoice) and the one waiting to be paid.
  invoice_ids uuid[] not null default '{}'::uuid[],
  pending_invoice_id uuid references public.invoices(id) on delete set null,
  previous_agreement_id uuid references public.service_agreements(id) on delete set null,
  renewed_by_agreement_id uuid references public.service_agreements(id) on delete set null,
  approval_id uuid references public.owner_approvals(id) on delete set null,
  -- The customer's own renewal link (/s/<slug>/plans/renew/<token>).
  renewal_token text unique check (renewal_token is null or renewal_token ~ '^[a-f0-9]{32}$'),
  renewal_approval_id uuid references public.owner_approvals(id) on delete set null,
  renewal_asked_at timestamptz,
  renewal_declined_at timestamptz,
  renewal_texted_at timestamptz,
  -- The price offered for the next term (the plan's price when the renewal link went out).
  renewal_price_cents integer check (renewal_price_cents is null or renewal_price_cents between 100 and 10000000),
  -- What the customer typed on the sign-up page (kept for the owner; the contact is the record).
  customer_name text check (customer_name is null or char_length(customer_name) <= 120),
  customer_phone text check (customer_phone is null or char_length(customer_phone) <= 20),
  customer_email text check (customer_email is null or char_length(customer_email) <= 254),
  service_address text check (service_address is null or char_length(service_address) <= 300),
  sms_consent_at timestamptz,
  -- The consent wording the customer ticked ("<version>: <text>"), kept with the timestamp.
  sms_consent_text text check (sms_consent_text is null or char_length(sms_consent_text) <= 600),
  -- The executor's claim (owner Y), so a retried decision never starts the plan twice.
  decision_claimed_at timestamptz,
  activated_at timestamptz,
  lapsed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  owner_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (term_end is null or term_start is null or term_end >= term_start),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
alter table public.service_agreements add column if not exists renewal_price_cents integer;
alter table public.service_agreements add column if not exists sms_consent_text text;
create index if not exists service_agreements_company_idx on public.service_agreements (company_id, status, term_end);
create index if not exists service_agreements_status_idx on public.service_agreements (status, term_end);
create index if not exists service_agreements_series_idx on public.service_agreements (recurring_job_id) where recurring_job_id is not null;
create index if not exists service_agreements_pending_invoice_idx on public.service_agreements (pending_invoice_id) where pending_invoice_id is not null;
-- One open agreement per customer per plan (a double-tapped sign-up makes one, not two).
create unique index if not exists service_agreements_one_open_idx
  on public.service_agreements (plan_id, contact_id)
  where status in ('pending_owner', 'pending_payment', 'active', 'renewal_due') and contact_id is not null;

-- ── 3. Customer texts ─────────────────────────────────────────────────────────────
create table if not exists public.service_plan_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  agreement_id uuid references public.service_agreements(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  kind text not null check (kind in ('confirmation', 'renewal', 'renewed', 'visit_heads_up', 'declined')),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'skipped', 'failed', 'blocked')),
  body text not null check (char_length(body) between 1 and 1000),
  to_phone text,
  not_before timestamptz not null default now(),
  attempts integer not null default 0,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, kind, dedupe_key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists service_plan_messages_queue_idx on public.service_plan_messages (not_before) where status = 'queued';

-- ── 4. Sweep claims (service role only) ───────────────────────────────────────────
create table if not exists public.service_plan_runs (
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null,
  run_key text not null,
  created_at timestamptz not null default now(),
  primary key (company_id, kind, run_key)
);

-- ── 5. Explicit visit dates on a recurring series ─────────────────────────────────
alter table public.recurring_jobs add column if not exists visit_dates date[];

-- ── RLS + grants ──────────────────────────────────────────────────────────────────
alter table public.service_plans enable row level security;
alter table public.service_agreements enable row level security;
alter table public.service_plan_messages enable row level security;
alter table public.service_plan_runs enable row level security;

-- Plan templates are what the public page shows anyway: every member may read them.
drop policy if exists "service_plans_select" on public.service_plans;
create policy "service_plans_select" on public.service_plans
  for select using (public.is_organization_member(organization_id));
-- Agreements and texts hold customers' details and money: owners/admins only.
drop policy if exists "service_agreements_select" on public.service_agreements;
create policy "service_agreements_select" on public.service_agreements
  for select using (public.is_organization_admin(organization_id));
drop policy if exists "service_plan_messages_select" on public.service_plan_messages;
create policy "service_plan_messages_select" on public.service_plan_messages
  for select using (public.is_organization_admin(organization_id));

revoke insert, update, delete on public.service_plans, public.service_agreements, public.service_plan_messages from anon, authenticated;
revoke select on public.service_plans, public.service_agreements, public.service_plan_messages from anon;
revoke all on public.service_plan_runs from anon, authenticated;
grant select on public.service_plans, public.service_agreements, public.service_plan_messages to authenticated;
grant all on public.service_plans, public.service_agreements, public.service_plan_messages, public.service_plan_runs to service_role;
-- The renewal token is the customer's credential for their renewal page: no client reads it.
revoke select on public.service_agreements from authenticated;
grant select (
  id, organization_id, company_id, plan_id, contact_id, status, source, plan_name, billing, price_cents,
  visit_months, term_start, term_end, visit_dates, recurring_job_id, invoice_ids, pending_invoice_id,
  previous_agreement_id, renewed_by_agreement_id, approval_id, renewal_approval_id, renewal_asked_at,
  renewal_declined_at, renewal_texted_at, renewal_price_cents, customer_name, customer_phone, customer_email, service_address,
  sms_consent_at, sms_consent_text, decision_claimed_at, activated_at, lapsed_at, cancelled_at, cancel_reason,
  owner_notified_at, created_at, updated_at
) on public.service_agreements to authenticated;

drop trigger if exists service_plans_set_updated_at on public.service_plans;
create trigger service_plans_set_updated_at before update on public.service_plans
  for each row execute procedure public.touch_updated_at();
drop trigger if exists service_agreements_set_updated_at on public.service_agreements;
create trigger service_agreements_set_updated_at before update on public.service_agreements
  for each row execute procedure public.touch_updated_at();
drop trigger if exists service_plan_messages_set_updated_at on public.service_plan_messages;
create trigger service_plan_messages_set_updated_at before update on public.service_plan_messages
  for each row execute procedure public.touch_updated_at();

comment on table public.service_plans is 'AI staff Service plans: maintenance plan templates (docs/ai-staff.md). Active ones are public at /s/<slug>/plans.';
comment on table public.service_agreements is 'One customer on one service plan for one term. Drives the recurring_jobs series it created (recurring_job_id). Owners/admins read.';
comment on column public.recurring_jobs.visit_dates is 'Explicit visit dates (service plans). NULL = generate from the rule (frequency / interval / weekdays), as before.';
