-- Multi-tenant edges: intake keys + voice numbers (Task 7).
--
-- A brand-new tenant can receive web leads (a per-tenant intake key) and Marina calls
-- (a voice number pinned to the tenant) with NO env change or deploy. The A1 spokes keep
-- working on the legacy env path until they are cut over (see docs/tenant-provisioning.md).
--
-- Additive: two new tables; existing telnyx_numbers rows are COPIED into voice_numbers
-- (the old table is kept one release for rollback). Nothing is dropped.

-- 1) Per-tenant intake keys. The full key is shown once at creation; only its sha256 is
--    stored, so a leaked DB never yields a usable key. key_prefix is the display handle.
create table public.intake_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  key_prefix text not null,
  key_hash text not null,
  label text,
  active boolean not null default true,
  last_used_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default timezone('utc', now()),
  unique (key_hash),
  -- Composite FK: a pinned company must belong to the key's org. company_id may be null
  -- (an org-level key); MATCH SIMPLE skips the check when it is.
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

create index intake_keys_org_idx on public.intake_keys (organization_id);

-- RLS: admins manage, members read. Resolution at request time uses the service-role
-- client (bypasses RLS) to look up by key_hash, so these policies only gate the UI.
alter table public.intake_keys enable row level security;

create policy "intake_keys_members_select"
  on public.intake_keys for select
  using (public.is_organization_member(organization_id));

create policy "intake_keys_admins_manage"
  on public.intake_keys for all
  using (public.is_organization_admin(organization_id))
  with check (public.is_organization_admin(organization_id));

-- 2) Voice numbers — the number a call arrived on decides the tenant + provider agent.
--    Supersedes telnyx_numbers (kept one release for rollback; deprecated in docs).
create table public.voice_numbers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  phone_e164 text not null unique,
  provider text not null check (provider in ('retell', 'telnyx')),
  -- Links the number to its provider agent (a Retell agent_id); null for telnyx.
  provider_agent_id text,
  brand_label text,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

create index voice_numbers_org_idx on public.voice_numbers (organization_id);
create index voice_numbers_agent_idx on public.voice_numbers (provider_agent_id);

alter table public.voice_numbers enable row level security;

create policy "voice_numbers_members_select"
  on public.voice_numbers for select
  using (public.is_organization_member(organization_id));

create policy "voice_numbers_admins_manage"
  on public.voice_numbers for all
  using (public.is_organization_admin(organization_id))
  with check (public.is_organization_admin(organization_id));

-- Copy existing Telnyx numbers over (provider 'telnyx'; no agent id). Idempotent on the
-- unique phone, so re-running is safe.
insert into public.voice_numbers
  (organization_id, company_id, phone_e164, provider, provider_agent_id, brand_label, active, created_at)
select organization_id, company_id, phone_e164, 'telnyx', null, brand_label, active, created_at
from public.telnyx_numbers
on conflict (phone_e164) do nothing;
