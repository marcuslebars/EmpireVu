-- Raw lead intake log: the durable-first write for every inbound lead (valid or not).
-- Written ONLY by the HMAC intake route via the service role; org members can read it.

create table public.raw_leads (
  id uuid primary key default gen_random_uuid(),
  lead_id text not null unique,
  organization_id uuid references public.organizations (id) on delete set null,
  company_id uuid,
  contact_id uuid,
  source text,
  source_site text,
  form_type text,
  schema_version integer,
  schema_valid boolean not null default false,
  matched boolean not null default false,
  needs_attention boolean not null default false,
  raw_payload jsonb not null,
  received_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  -- Composite FKs keep company/contact within the same org (only enforced when
  -- organization_id is non-null; unresolved leads carry nulls and are still stored).
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete set null,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete set null
);

create index raw_leads_org_created_idx on public.raw_leads (organization_id, created_at desc);
create index raw_leads_source_site_idx on public.raw_leads (source_site, created_at desc);
create index raw_leads_needs_attention_idx on public.raw_leads (needs_attention, created_at desc);

-- Faster phone-based customer matching (email is already citext + indexed).
create index if not exists contacts_org_phone_idx on public.contacts (organization_id, phone);

create trigger raw_leads_set_updated_at
before update on public.raw_leads
for each row execute procedure public.touch_updated_at();

alter table public.raw_leads enable row level security;

-- Read: org members can view raw leads (the "needs attention" inbox).
-- Write: no anon/authenticated insert/update/delete policy — only the service role
-- (the intake route) writes, and it bypasses RLS by design (see intake.ts).
create policy "raw_leads_org_members_select"
  on public.raw_leads for select
  using (public.is_organization_member(organization_id));
