-- Self-serve onboarding wizard (Task 13): resumable progress + instrumentation + the
-- business-profile columns the Business step collects, and a Storage bucket for logos.

-- ── 1) companies: onboarding business-profile columns ────────────────────────
-- timezone + website already exist; hours + service_area are new. (website is reused as
-- the business website; brand_* already exist.)
alter table public.companies add column if not exists hours jsonb;
alter table public.companies add column if not exists service_area text;

-- ── 2) onboarding_progress — one row per (company, step), resumable ───────────
create table if not exists public.onboarding_progress (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  step text not null,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'complete', 'error')),
  data jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, company_id, step)
);

create index if not exists onboarding_progress_org_company_idx
  on public.onboarding_progress (organization_id, company_id);

alter table public.onboarding_progress enable row level security;

create policy "onboarding_progress_members_select"
  on public.onboarding_progress for select
  using (public.is_organization_member(organization_id));
create policy "onboarding_progress_members_insert"
  on public.onboarding_progress for insert
  with check (public.is_organization_member(organization_id));
create policy "onboarding_progress_members_update"
  on public.onboarding_progress for update
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

-- ── 3) onboarding_events — append-only instrumentation (funnel + timings) ─────
create table if not exists public.onboarding_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  step text not null,
  event text not null check (event in ('start', 'complete', 'error')),
  occurred_at timestamptz not null default timezone('utc', now()),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists onboarding_events_org_idx
  on public.onboarding_events (organization_id, occurred_at);
create index if not exists onboarding_events_step_idx
  on public.onboarding_events (step, event, occurred_at);

alter table public.onboarding_events enable row level security;

create policy "onboarding_events_members_select"
  on public.onboarding_events for select
  using (public.is_organization_member(organization_id));
create policy "onboarding_events_members_insert"
  on public.onboarding_events for insert
  with check (public.is_organization_member(organization_id));

-- ── 4) Storage: `branding` bucket for company logos ───────────────────────────
-- Public read (logos render on the hosted quote page + in emails, both unauthenticated).
-- Writes are service-role only: the Business step uploads via the admin client after the
-- authed org-member check, to a path prefixed by the org id. No client insert policy →
-- authenticated users cannot write directly (RLS denies; service_role bypasses).
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

drop policy if exists "branding_public_read" on storage.objects;
create policy "branding_public_read"
  on storage.objects for select
  using (bucket_id = 'branding');
