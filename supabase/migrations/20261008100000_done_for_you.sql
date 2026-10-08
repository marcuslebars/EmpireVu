-- Done-for-you setup (docs/done-for-you.md).
--
-- A CrankLeads buyer no longer works through a self-serve wizard. After payment they get a
-- text with a no-login "quick setup" link (setup_intakes), we enrich their company from their
-- website / Google listing, switch everything on, build and host a page for them
-- (company_sites), and an operator finishes anything left from the concierge console.
--
-- Additive only. All writes go through the server (service role); members can READ their own
-- rows. Following 20261006170000_lock_privileged_columns, nothing here is client-writable.
-- Rollback: supabase/rollback/20261008100000_done_for_you.down.sql

-- ── Company facts gathered for the buyer ──────────────────────────────────────
alter table public.companies
  add column if not exists google_place_id text,
  add column if not exists google_rating numeric(2,1),
  add column if not exists google_review_count integer,
  add column if not exists business_phone_kind text,
  add column if not exists business_phone_carrier text,
  add column if not exists profile jsonb not null default '{}'::jsonb;

alter table public.companies drop constraint if exists companies_business_phone_kind_check;
alter table public.companies add constraint companies_business_phone_kind_check
  check (business_phone_kind is null or business_phone_kind in ('cell', 'landline', 'voip'));

comment on column public.companies.profile is
  'Public-facing business profile gathered for the generated site: { tagline, about, highlights[], photos[], social{}, source{} }.';
comment on column public.companies.business_phone_carrier is
  'Carrier of the business line (bell, rogers, telus, fido, koodo, virgin, freedom, videotron, other) — picks the forwarding code.';

-- ── Quick-setup intake (one per company) ──────────────────────────────────────
create table if not exists public.setup_intakes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null unique references public.companies(id) on delete cascade,
  token text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'opened', 'submitted', 'enriching', 'enriched', 'failed')),
  answers jsonb not null default '{}'::jsonb,
  enrichment jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  opened_at timestamptz,
  submitted_at timestamptz,
  enriched_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists setup_intakes_org_idx on public.setup_intakes (organization_id);
create index if not exists setup_intakes_status_idx on public.setup_intakes (status);

alter table public.setup_intakes enable row level security;
drop policy if exists "setup_intakes_select" on public.setup_intakes;
create policy "setup_intakes_select" on public.setup_intakes
  for select using (public.is_organization_member(organization_id));
revoke insert, update, delete on public.setup_intakes from anon, authenticated;

-- ── Generated website / price page (one per company) ──────────────────────────
create table if not exists public.company_sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null unique references public.companies(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,60}[a-z0-9])?$'),
  mode text not null default 'full' check (mode in ('full', 'price_page')),
  status text not null default 'draft' check (status in ('draft', 'published', 'unpublished')),
  content jsonb not null default '{}'::jsonb,
  generated_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists company_sites_org_idx on public.company_sites (organization_id);

alter table public.company_sites enable row level security;
drop policy if exists "company_sites_select" on public.company_sites;
create policy "company_sites_select" on public.company_sites
  for select using (public.is_organization_member(organization_id));
revoke insert, update, delete on public.company_sites from anon, authenticated;

-- ── Concierge (operator) audit trail ──────────────────────────────────────────
create table if not exists public.operator_actions (
  id uuid primary key default gen_random_uuid(),
  operator_email text not null,
  organization_id uuid references public.organizations(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists operator_actions_org_idx on public.operator_actions (organization_id, created_at desc);

alter table public.operator_actions enable row level security;
revoke all on public.operator_actions from anon, authenticated;
