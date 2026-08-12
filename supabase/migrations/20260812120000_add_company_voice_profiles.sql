-- Per-company voice profiles — so the "Marina" outbound agent calls each lead with the
-- right brand's context (knowledge base + system prompt) based on the company the lead
-- came in from.
--
-- A Retell knowledge base is attached to an AGENT, so each company gets its own Retell
-- agent (its KB + prompt, authored in the Retell dashboard). This table maps a company to
-- that agent, plus an optional per-brand caller-ID number, a greeting label, and extra
-- static dynamic variables the agent's prompt can interpolate. At call time EmpireVu
-- resolves the calling contact's company_id → this profile → override_agent_id +
-- from_number + merged retell_llm_dynamic_variables.
--
-- Created + edited by authenticated Hub users (org members write under RLS), like quotes.

create table public.company_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null unique,

  -- The Retell agent (carrying THIS brand's KB + system prompt) for outbound calls.
  retell_outbound_agent_id text,
  -- Optional per-brand caller ID (E.164); falls back to the global RETELL_FROM_NUMBER.
  from_number text,
  -- Greeting name for the {{company_name}} dynamic variable; falls back to companies.name.
  brand_label text,
  -- Extra static dynamic variables for this brand (e.g. services, hours, booking link).
  dynamic_variables jsonb not null default '{}'::jsonb,
  active boolean not null default true,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

create index company_voice_profiles_org_idx on public.company_voice_profiles (organization_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────
create trigger company_voice_profiles_set_updated_at
before update on public.company_voice_profiles
for each row execute procedure public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: org members read + write (Hub-managed).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.company_voice_profiles enable row level security;

create policy "company_voice_profiles_org_members_select" on public.company_voice_profiles
  for select using (public.is_organization_member(organization_id));
create policy "company_voice_profiles_org_members_insert" on public.company_voice_profiles
  for insert with check (public.is_organization_member(organization_id));
create policy "company_voice_profiles_org_members_update" on public.company_voice_profiles
  for update using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
