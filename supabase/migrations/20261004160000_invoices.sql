-- Invoicing — tenant-to-customer invoices, business (marina) accounts, payments.
--
-- What this adds, and why each piece exists:
--
--   • customer_accounts      — a BUSINESS customer (a marina, a yacht club, a fleet
--                              owner). Until now EmpireVu only knew individual
--                              people. A marina has a billing email, an address,
--                              Net-30 terms and several staff; those staff are
--                              ordinary contacts linked via contacts.customer_account_id.
--   • companies.* settings   — what a real tax invoice must print (HST registration
--                              number, business address) and how the brand gets paid
--                              (terms, e-Transfer address, cheque payee, whether bank
--                              debit is offered). Settings live in one jsonb so new
--                              knobs don't need a migration; the app parses them with
--                              a schema and supplies defaults.
--   • invoices               — the invoice itself. Line items + money split in integer
--                              cents, a public token for the hosted page /i/{token},
--                              and links back to the quote / booking it came from.
--   • invoice_payments       — every payment against an invoice: Stripe card / wallet /
--                              pre-authorized debit (written by the webhook) and the
--                              offline ones a person records (e-Transfer, cheque, cash).
--                              Bank debit takes days to clear, so a payment can sit in
--                              'pending' before it counts.
--   • invoice_events         — append-only audit trail, like quote_events.
--   • per-BRAND numbering    — INV-2026-0001. Per company, not per org: the A1 brands
--                              are separate businesses and each invoice series must be
--                              unbroken on its own.
--   • refresh_invoice_balance — the ONE place paid / balance / status are derived from
--                              the payments, so the webhook and a person recording a
--                              cheque can never disagree about what is owed.
--
-- Additive only. Nothing existing is dropped or retyped.

-- ─────────────────────────────────────────────────────────────────────────────
-- Business customers
-- ─────────────────────────────────────────────────────────────────────────────
create table public.customer_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  billing_email citext,
  billing_phone text,
  -- Free-form, printed as-is on the invoice ("123 Marina Rd\nMidland ON L4R 1A1").
  billing_address text,
  -- The customer's own GST/HST number, if they want it on their invoices.
  tax_number text,
  -- null = use the brand's default terms.
  payment_terms_days integer check (payment_terms_days is null or payment_terms_days between 0 and 365),
  notes text,
  archived_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, organization_id)
);

create index customer_accounts_org_name_idx on public.customer_accounts (organization_id, lower(name));

create trigger customer_accounts_set_updated_at
before update on public.customer_accounts
for each row execute procedure public.touch_updated_at();

-- A contact can belong to one business account (the marina manager, the dock hand).
alter table public.contacts add column if not exists customer_account_id uuid;
alter table public.contacts
  add constraint contacts_customer_account_fk
  foreign key (customer_account_id, organization_id)
  references public.customer_accounts (id, organization_id)
  on delete set null (customer_account_id);
create index if not exists contacts_customer_account_idx
  on public.contacts (customer_account_id) where customer_account_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Brand invoice settings
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.companies add column if not exists tax_registration_number text;
alter table public.companies add column if not exists business_address text;
-- Parsed by src/server/services/invoices/settings.ts (defaults applied there).
alter table public.companies add column if not exists invoice_settings jsonb not null default '{}'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices
-- ─────────────────────────────────────────────────────────────────────────────
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Required: numbering, Stripe account, tax number and branding are all per brand.
  company_id uuid not null,
  contact_id uuid,
  customer_account_id uuid,
  quote_id uuid references public.quotes (id) on delete set null,
  booking_id uuid,

  -- Allocated on send (drafts don't burn numbers). Unique per brand.
  invoice_number text,
  public_token text not null unique,

  status text not null default 'draft'
    check (status in ('draft', 'sent', 'viewed', 'partially_paid', 'paid', 'void')),
  currency text not null default 'CAD',

  title text,
  -- [{ label, description, quantity, unitPriceCents, amountCents }] — amounts may be
  -- negative (a discount line).
  line_items jsonb not null default '[]'::jsonb,
  subtotal_cents integer not null default 0,
  tax_rate_bps integer not null default 1300 check (tax_rate_bps between 0 and 5000),
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  -- Money already received before this invoice existed (the quote's deposit).
  credit_cents integer not null default 0 check (credit_cents >= 0),
  -- Derived by refresh_invoice_balance — never written directly by the app.
  amount_paid_cents integer not null default 0,
  pending_payment_cents integer not null default 0,
  balance_due_cents integer not null default 0,

  issue_date date,
  due_date date,
  payment_terms_days integer not null default 0 check (payment_terms_days between 0 and 365),

  -- Snapshot of who it is addressed to at the time it was issued, so editing the
  -- contact later never rewrites a sent invoice: { name, company, email, phone, address }.
  bill_to jsonb not null default '{}'::jsonb,
  -- Customer-visible message, and the internal note only staff see.
  notes text,
  internal_notes text,

  sent_at timestamptz,
  first_viewed_at timestamptz,
  paid_at timestamptz,
  -- Set once, by a conditional update, so "invoice paid" fires exactly once.
  paid_notified_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  last_reminder_at timestamptz,
  reminder_count integer not null default 0,
  stripe_checkout_session_id text,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  unique (id, organization_id),
  check (contact_id is not null or customer_account_id is not null),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete restrict,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete set null (contact_id),
  foreign key (customer_account_id, organization_id)
    references public.customer_accounts (id, organization_id) on delete set null (customer_account_id),
  foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete set null (booking_id)
);

create unique index invoices_company_number_uniq
  on public.invoices (company_id, invoice_number) where invoice_number is not null;
-- A quote or a booking is invoiced once. Voiding frees it to be invoiced again.
create unique index invoices_quote_live_uniq
  on public.invoices (quote_id) where quote_id is not null and status <> 'void';
create unique index invoices_booking_live_uniq
  on public.invoices (booking_id) where booking_id is not null and status <> 'void';
create index invoices_org_created_idx on public.invoices (organization_id, created_at desc);
create index invoices_org_status_idx on public.invoices (organization_id, status);
create index invoices_contact_idx on public.invoices (contact_id) where contact_id is not null;
create index invoices_account_idx on public.invoices (customer_account_id) where customer_account_id is not null;
-- The reminder sweep: open invoices by due date.
create index invoices_open_due_idx
  on public.invoices (due_date) where status in ('sent', 'viewed', 'partially_paid');

create trigger invoices_set_updated_at
before update on public.invoices
for each row execute procedure public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Payments
-- ─────────────────────────────────────────────────────────────────────────────
create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  invoice_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  method text not null
    check (method in ('card', 'bank_debit', 'etransfer', 'cheque', 'cash', 'other')),
  status text not null default 'succeeded'
    check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  -- e-Transfer reference / cheque number / Stripe receipt number.
  reference text,
  received_at timestamptz not null default timezone('utc', now()),
  notes text,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  failure_reason text,
  recorded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (invoice_id, organization_id)
    references public.invoices (id, organization_id) on delete cascade,
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete restrict
);

-- One row per Stripe payment, so a redelivered webhook can never record it twice.
-- A full (not partial) unique index so the webhook's upsert can target it with
-- ON CONFLICT (stripe_payment_intent_id); NULLs (staff-recorded payments) never collide.
create unique index invoice_payments_pi_uniq
  on public.invoice_payments (stripe_payment_intent_id);
create index invoice_payments_invoice_idx on public.invoice_payments (invoice_id, received_at desc);

create trigger invoice_payments_set_updated_at
before update on public.invoice_payments
for each row execute procedure public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit trail
-- ─────────────────────────────────────────────────────────────────────────────
create table public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  invoice_id uuid not null,
  event_type text not null,
  actor_profile_id uuid references public.profiles (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (invoice_id, organization_id)
    references public.invoices (id, organization_id) on delete cascade
);

create index invoice_events_invoice_idx on public.invoice_events (invoice_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-brand invoice numbers. Returns "2026-0001"; the app adds the prefix.
-- Callable by org members (for their own brands) and the service role.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.invoice_number_counters (
  company_id uuid not null references public.companies (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  year integer not null,
  last_number integer not null default 0,
  primary key (company_id, year)
);

create or replace function public.next_invoice_number(p_company_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_year integer := extract(year from timezone('utc', now()))::integer;
  v_next integer;
begin
  select organization_id into v_org from public.companies where id = p_company_id;
  if v_org is null then
    raise exception 'company % not found', p_company_id;
  end if;
  -- security definer bypasses RLS, so membership is checked here explicitly.
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_organization_member(v_org) then
    raise exception 'not a member of this organization';
  end if;

  insert into public.invoice_number_counters (company_id, organization_id, year, last_number)
  values (p_company_id, v_org, v_year, 1)
  on conflict (company_id, year)
    do update set last_number = public.invoice_number_counters.last_number + 1
  returning last_number into v_next;

  return v_year::text || '-' || lpad(v_next::text, 4, '0');
end;
$$;

revoke all on function public.next_invoice_number(uuid) from public;
grant execute on function public.next_invoice_number(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Derive paid / pending / balance / status from the payments.
--
-- SECURITY INVOKER: a member recording a cheque runs it under RLS; the Stripe
-- webhook runs it as the service role. Draft and void invoices keep their status.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.refresh_invoice_balance(p_invoice_id uuid)
returns setof public.invoices
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_paid integer;
  v_pending integer;
begin
  select
    coalesce(sum(amount_cents) filter (where status = 'succeeded'), 0),
    coalesce(sum(amount_cents) filter (where status = 'pending'), 0)
  into v_paid, v_pending
  from public.invoice_payments
  where invoice_id = p_invoice_id;

  return query
  update public.invoices i
  set
    amount_paid_cents = v_paid,
    pending_payment_cents = v_pending,
    balance_due_cents = greatest(i.total_cents - i.credit_cents - v_paid, 0),
    status = case
      when i.status in ('draft', 'void') then i.status
      when i.total_cents - i.credit_cents - v_paid <= 0 then 'paid'
      when v_paid > 0 then 'partially_paid'
      when i.first_viewed_at is not null then 'viewed'
      else 'sent'
    end,
    paid_at = case
      when i.status not in ('draft', 'void') and i.total_cents - i.credit_cents - v_paid <= 0
        then coalesce(i.paid_at, timezone('utc', now()))
      else null
    end
  where i.id = p_invoice_id
  returning i.*;
end;
$$;

grant execute on function public.refresh_invoice_balance(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: org members read + write. Stripe webhooks and the public invoice page
-- write via the service role (RLS-exempt).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.customer_accounts enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_payments enable row level security;
alter table public.invoice_events enable row level security;
alter table public.invoice_number_counters enable row level security;

create policy "customer_accounts_org_members_select" on public.customer_accounts
  for select using (public.is_organization_member(organization_id));
create policy "customer_accounts_org_members_insert" on public.customer_accounts
  for insert with check (public.is_organization_member(organization_id));
create policy "customer_accounts_org_members_update" on public.customer_accounts
  for update using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy "invoices_org_members_select" on public.invoices
  for select using (public.is_organization_member(organization_id));
create policy "invoices_org_members_insert" on public.invoices
  for insert with check (public.is_organization_member(organization_id));
create policy "invoices_org_members_update" on public.invoices
  for update using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy "invoice_payments_org_members_select" on public.invoice_payments
  for select using (public.is_organization_member(organization_id));
create policy "invoice_payments_org_members_insert" on public.invoice_payments
  for insert with check (public.is_organization_member(organization_id));
create policy "invoice_payments_org_members_update" on public.invoice_payments
  for update using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy "invoice_events_org_members_select" on public.invoice_events
  for select using (public.is_organization_member(organization_id));
create policy "invoice_events_org_members_insert" on public.invoice_events
  for insert with check (public.is_organization_member(organization_id));

create policy "invoice_number_counters_org_members_select" on public.invoice_number_counters
  for select using (public.is_organization_member(organization_id));
