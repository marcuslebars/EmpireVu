-- Monthly results scorecard (CrankLeads promise: "leads caught, replies sent, jobs booked,
-- and what we're tuning next"). See docs/monthly-scorecard.md.
--
-- companies.monthly_scorecard holds the per-company settings blob:
--   { "enabled": bool }
-- null / missing => ENABLED (opt-out model: every done-for-you client gets the scorecard
-- unless an admin turns it off). `{ "enabled": false }` is the opt-out.
alter table public.companies add column if not exists monthly_scorecard jsonb;

-- One row per (company, month) — the send log / idempotency guard. `month` is the first day
-- of the calendar month in the COMPANY's timezone (YYYY-MM-01). The job claims the row
-- before sending; the unique constraint makes a second run for the same month a no-op
-- (a manual `--force` re-send updates the row instead). Written by the monthly-scorecard
-- job (service role, sanctioned: jobs); members may read it for the "last sent" line.
create table if not exists public.monthly_scorecard_sends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  month date not null check (extract(day from month) = 1),
  status text not null default 'claimed'
    check (status in ('claimed', 'sent', 'failed', 'skipped')),
  email_status text,
  recipient text,
  subject text,
  send_count integer not null default 0,
  detail jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade,
  unique (company_id, month)
);

create index if not exists monthly_scorecard_sends_org_company_month_idx
  on public.monthly_scorecard_sends (organization_id, company_id, month desc);

alter table public.monthly_scorecard_sends enable row level security;

create policy "monthly_scorecard_sends_members_select"
  on public.monthly_scorecard_sends for select
  using (public.is_organization_member(organization_id));

-- Optional free-text operator note per (company, month), shown under "What we're tuning
-- next". Set by an org owner/admin (the operator) before the send; members may read it.
create table if not exists public.monthly_scorecard_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  month date not null check (extract(day from month) = 1),
  note text not null check (char_length(note) <= 2000),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade,
  unique (company_id, month)
);

create index if not exists monthly_scorecard_notes_org_company_month_idx
  on public.monthly_scorecard_notes (organization_id, company_id, month desc);

alter table public.monthly_scorecard_notes enable row level security;

create policy "monthly_scorecard_notes_members_select"
  on public.monthly_scorecard_notes for select
  using (public.is_organization_member(organization_id));
create policy "monthly_scorecard_notes_admins_insert"
  on public.monthly_scorecard_notes for insert
  with check (public.is_organization_admin(organization_id));
create policy "monthly_scorecard_notes_admins_update"
  on public.monthly_scorecard_notes for update
  using (public.is_organization_admin(organization_id))
  with check (public.is_organization_admin(organization_id));
create policy "monthly_scorecard_notes_admins_delete"
  on public.monthly_scorecard_notes for delete
  using (public.is_organization_admin(organization_id));
