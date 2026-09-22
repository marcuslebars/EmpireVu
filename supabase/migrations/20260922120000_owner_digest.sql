-- Owner daily digest (Task 15): per-company morning summary sent to the owner.
--
-- companies.digest holds the per-company settings blob (persona-agnostic, owner-editable):
--   { "enabled": bool, "send_at_local": "HH:MM" (default 06:30), "channels": ["email","sms"],
--     "always_send": bool }
-- null / missing => disabled. The digest is company-scoped: an owner with several companies
-- gets one message per enabled company (Task 15 does not roll companies up).
alter table public.companies add column if not exists digest jsonb;

-- One row per (company, local_date) — the idempotency guard. local_date is the calendar
-- date in the COMPANY's timezone (a UTC date would double-send around midnight UTC). The
-- scheduler claims the row before sending; the unique constraint makes a second same-day
-- send a no-op. Written by the worker (service role); members may read it for the "last
-- sent" line in settings.
create table if not exists public.owner_digest_sends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  local_date date not null,
  channels_sent text[] not null default '{}',
  sms_status text,
  email_status text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade,
  unique (company_id, local_date)
);

create index if not exists owner_digest_sends_org_company_date_idx
  on public.owner_digest_sends (organization_id, company_id, local_date desc);

alter table public.owner_digest_sends enable row level security;

create policy "owner_digest_sends_members_select"
  on public.owner_digest_sends for select
  using (public.is_organization_member(organization_id));
create policy "owner_digest_sends_members_insert"
  on public.owner_digest_sends for insert
  with check (public.is_organization_member(organization_id));
