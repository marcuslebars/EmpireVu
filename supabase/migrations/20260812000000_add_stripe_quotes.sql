-- Stripe-native quotes — Phase 2: domain model + pricing (no Stripe API yet).
--
-- A quote is priced from the shared @a1/pricing-engine, stored with its line items and
-- money split (subtotal / tax / total / deposit — all integer cents), and moves through
-- a lifecycle: draft → sent → approved → deposit_paid (or expired / cancelled). Phases
-- 3-4 add the hosted approval page, the Stripe deposit Checkout, and the balance
-- invoice; the stripe_* columns below are populated then.
--
-- Unlike the webhook-driven telnyx_/retell_ tables, quotes are created by authenticated
-- Hub users, so org members can INSERT/UPDATE under RLS. The Phase 3 Stripe webhook
-- writes via the service role (RLS-exempt). The whole feature is inert unless
-- STRIPE_QUOTES_ENABLED=1 — nothing here runs on its own.

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  contact_id uuid,

  -- Unguessable token for the Phase 3 hosted page /q/{public_token} (app-generated).
  public_token text not null unique,
  -- Optional human-friendly reference (e.g. Q-2026-0001); assigned later.
  quote_number text,

  status text not null default 'draft'
    check (status in ('draft', 'sent', 'approved', 'deposit_paid', 'expired', 'cancelled')),
  currency text not null default 'CAD',

  -- Priced snapshot: engine line items + the money split (all integer cents).
  line_items jsonb not null default '[]'::jsonb,
  subtotal_cents integer not null default 0,
  tax_cents integer not null default 0,
  total_cents integer not null default 0,
  deposit_cents integer not null default 0,
  tax_rate_bps integer not null default 1300,      -- HST 13%, basis points
  deposit_rate_bps integer not null default 2500,  -- 25% deposit, basis points
  bundle_id text,

  -- The pricing inputs, kept verbatim for reprice / audit.
  input_snapshot jsonb not null default '{}'::jsonb,
  notes text,
  source text,

  expires_at timestamptz,

  -- Populated in Phases 3-4 (Stripe). Nullable now.
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  deposit_paid_at timestamptz,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete set null,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete set null
);

create index quotes_org_created_idx on public.quotes (organization_id, created_at desc);
create index quotes_org_status_idx on public.quotes (organization_id, status);
create index quotes_contact_idx on public.quotes (contact_id);

-- Append-only audit trail: created | priced | sent | viewed | approved | deposit_paid
-- | expired | cancelled | repriced.
create table public.quote_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  event_type text not null,
  actor_profile_id uuid references public.profiles (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index quote_events_quote_idx on public.quote_events (quote_id, created_at desc);
create index quote_events_org_created_idx on public.quote_events (organization_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at trigger (quotes only; quote_events are append-only).
-- ─────────────────────────────────────────────────────────────────────────────
create trigger quotes_set_updated_at
before update on public.quotes
for each row execute procedure public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: org members read + write (Hub-created). The Phase 3 Stripe webhook writes
-- via the service role, which is RLS-exempt, so it needs no policy.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.quotes enable row level security;
alter table public.quote_events enable row level security;

create policy "quotes_org_members_select" on public.quotes
  for select using (public.is_organization_member(organization_id));
create policy "quotes_org_members_insert" on public.quotes
  for insert with check (public.is_organization_member(organization_id));
create policy "quotes_org_members_update" on public.quotes
  for update using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy "quote_events_org_members_select" on public.quote_events
  for select using (public.is_organization_member(organization_id));
create policy "quote_events_org_members_insert" on public.quote_events
  for insert with check (public.is_organization_member(organization_id));
