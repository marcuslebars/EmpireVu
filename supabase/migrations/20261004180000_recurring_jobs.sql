-- Recurring jobs: repeat work on a schedule (weekly / monthly / yearly).
--   * recurring_jobs — the series: customer, what, when it repeats, usual crew,
--     checklist and price
--   * bookings.recurring_job_id / occurrence_date — each visit is an ordinary booking;
--     (recurring_job_id, occurrence_date) is unique so generation is idempotent
--   * bookings.recurrence_exception — this visit was moved by hand; series edits leave it alone
-- Rollback: supabase/rollback/20261004180000_recurring_jobs.down.sql

create table if not exists public.recurring_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  description text,
  location text,
  duration_minutes integer not null default 60 check (duration_minutes between 5 and 1440),
  -- The rule
  frequency text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  interval_count integer not null default 1 check (interval_count between 1 and 52),
  weekdays smallint[] not null default '{}'::smallint[],   -- weekly: 0=Sun … 6=Sat; empty = start date's weekday
  start_date date not null,
  time_of_day text not null check (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ends_on date,
  max_occurrences integer check (max_occurrences is null or max_occurrences between 1 and 1000),
  -- What each visit carries
  crew_profile_ids uuid[] not null default '{}'::uuid[],
  checklist_template_id uuid references public.checklist_templates (id) on delete set null,
  line_items jsonb not null default '[]'::jsonb check (jsonb_typeof(line_items) = 'array'),
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  generated_through date,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (ends_on is null or ends_on >= start_date)
);

create index if not exists recurring_jobs_org_idx on public.recurring_jobs (organization_id, company_id, status);

drop trigger if exists recurring_jobs_set_updated_at on public.recurring_jobs;
create trigger recurring_jobs_set_updated_at
before update on public.recurring_jobs
for each row execute procedure public.touch_updated_at();

alter table public.recurring_jobs enable row level security;

drop policy if exists "recurring_jobs_members_select" on public.recurring_jobs;
drop policy if exists "recurring_jobs_members_write" on public.recurring_jobs;
create policy "recurring_jobs_members_select"
  on public.recurring_jobs for select
  using (public.is_organization_member(organization_id));
create policy "recurring_jobs_members_write"
  on public.recurring_jobs for all
  using (public.is_organization_member(organization_id))
  with check (
    public.is_organization_member(organization_id)
    and exists (select 1 from public.companies c where c.id = company_id and c.organization_id = recurring_jobs.organization_id)
    and (contact_id is null or exists (select 1 from public.contacts ct where ct.id = contact_id and ct.organization_id = recurring_jobs.organization_id))
  );

alter table public.bookings add column if not exists recurring_job_id uuid references public.recurring_jobs (id) on delete set null;
alter table public.bookings add column if not exists occurrence_date date;
alter table public.bookings add column if not exists recurrence_exception boolean not null default false;

-- Full (not partial) unique index so ON CONFLICT can target it; NULLs never collide,
-- so ordinary one-off bookings are unaffected.
create unique index if not exists bookings_recurring_occurrence_key
  on public.bookings (recurring_job_id, occurrence_date);

grant select, insert, update, delete on public.recurring_jobs to authenticated, service_role;
