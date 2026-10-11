-- Phase 3 AI staff: the RECRUITER, hiring & payroll (docs/ai-staff.md → "Hiring & payroll").
--
-- Payroll
--   1. pay_periods: one row per company per pay period (unique company + start date). The
--      morning after a period ends the owner gets a `payroll_period` approval; Y locks it and
--      emails the CSV. Only dates, status and company-level totals live here (no per-person
--      hours), so every member may read it: the timesheet screens use it to say "locked".
--   2. pay_period_events: the audit log (asked, locked, unlocked, csv_emailed, csv_downloaded).
--      Owners/admins read it; only the server writes it.
--   3. A trigger on time_entries refuses client (browser / user-session) inserts, edits and
--      deletes of entries that fall in a LOCKED pay period. Stopping a clock that was left
--      running when the owner locked "anyway" is still allowed. The service role and SECURITY
--      DEFINER functions (close_job_time_entries) are not affected (is_client_role()).
--
-- Hiring
--   4. job_postings: the AI-drafted job post the owner OKs (`job_post`); open ones are shown on
--      the company site at /s/<slug>/jobs.
--   5. job_applicants: one row per job per phone number, with the AI screening score. Personal
--      information, so only owners/admins read it.
--   6. recruiter_sweep_claims: once-per-day claims for the daily applicant digest.
--
-- Settings live in companies.ai_settings.recruiter (read in code, defaults there).
-- Additive and re-runnable. Nothing here is client-writable (see 20261006170000).
-- Rollback: supabase/rollback/20261012130000_staff_recruiter.down.sql

-- ── 1. Pay periods ─────────────────────────────────────────────────────────────────
create table if not exists public.pay_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  frequency text not null check (frequency in ('weekly', 'biweekly', 'semimonthly')),
  -- Local calendar dates in the company's zone: start_date .. end_date inclusive.
  start_date date not null,
  end_date date not null,
  -- The same period as instants: [starts_at, ends_at) — local midnights.
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'awaiting_owner', 'locked', 'unlocked', 'skipped', 'expired', 'empty')),
  approval_id uuid references public.owner_approvals(id) on delete set null,
  -- Company-level totals from the last summary (no per-person hours here).
  people integer not null default 0,
  total_minutes integer not null default 0,
  ot_minutes integer not null default 0,
  open_entries integer not null default 0,
  locked_at timestamptz,
  locked_via text,
  locked_by text,
  locked_with_open_entries boolean not null default false,
  unlocked_at timestamptz,
  unlocked_by uuid references public.profiles(id) on delete set null,
  unlock_reason text check (unlock_reason is null or char_length(unlock_reason) <= 500),
  csv_emailed_at timestamptz,
  csv_emailed_to text,
  csv_email_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (ends_at > starts_at),
  unique (company_id, start_date),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists pay_periods_org_range_idx on public.pay_periods (organization_id, starts_at, ends_at);
create index if not exists pay_periods_locked_idx on public.pay_periods (organization_id, starts_at) where status = 'locked';

create table if not exists public.pay_period_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  period_id uuid not null references public.pay_periods(id) on delete cascade,
  action text not null check (action in ('asked', 'locked', 'unlocked', 'csv_emailed', 'csv_downloaded', 'skipped')),
  -- 'owner_sms:+1705…', 'profile:<uuid>', 'system'
  actor text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists pay_period_events_period_idx on public.pay_period_events (period_id, created_at desc);

-- ── 2. The lock on time_entries ────────────────────────────────────────────────────
-- True when a locked pay period covers an entry starting at p_started_at. An entry with no
-- company (general time) is covered by any of the org's locked periods.
create or replace function public.time_entry_in_locked_period(p_org uuid, p_company uuid, p_started_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.pay_periods p
    where p.organization_id = p_org
      and p.status = 'locked'
      and p.starts_at <= p_started_at
      and p.ends_at > p_started_at
      and (p_company is null or p.company_id = p_company)
  );
$$;
revoke all on function public.time_entry_in_locked_period(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.time_entry_in_locked_period(uuid, uuid, timestamptz) to authenticated, service_role;

-- SECURITY INVOKER on purpose: is_client_role() must see the caller's role.
create or replace function public.time_entries_enforce_pay_period_lock()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not public.is_client_role() then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    -- Stopping a clock left running when the period was locked "anyway".
    if tg_op = 'UPDATE'
       and old.ended_at is null and new.ended_at is not null
       and new.started_at = old.started_at
       and new.break_minutes = old.break_minutes
       and new.profile_id = old.profile_id
       and new.booking_id is not distinct from old.booking_id
       and new.company_id is not distinct from old.company_id then
      return new;
    end if;
    if public.time_entry_in_locked_period(old.organization_id, old.company_id, old.started_at) then
      raise exception 'pay_period_locked'
        using errcode = 'P0001', hint = 'These hours are locked for payroll. An owner or admin can unlock the pay period.';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if public.time_entry_in_locked_period(new.organization_id, new.company_id, new.started_at) then
      raise exception 'pay_period_locked'
        using errcode = 'P0001', hint = 'These hours are locked for payroll. An owner or admin can unlock the pay period.';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists time_entries_pay_period_lock on public.time_entries;
create trigger time_entries_pay_period_lock
before insert or update or delete on public.time_entries
for each row execute procedure public.time_entries_enforce_pay_period_lock();

-- ── 3. Job postings ────────────────────────────────────────────────────────────────
create table if not exists public.job_postings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  title text not null check (char_length(title) between 1 and 120),
  pay_text text check (pay_text is null or char_length(pay_text) <= 120),
  employment_type text check (employment_type is null or char_length(employment_type) <= 60),
  start_text text check (start_text is null or char_length(start_text) <= 120),
  location text check (location is null or char_length(location) <= 160),
  summary text check (summary is null or char_length(summary) <= 600),
  duties jsonb not null default '[]'::jsonb,
  requirements jsonb not null default '[]'::jsonb,
  nice_to_have jsonb not null default '[]'::jsonb,
  -- Up to 3 extra job-related questions on the apply form: ["Do you have your Working at Heights?"]
  custom_questions jsonb not null default '[]'::jsonb,
  -- What the owner texted (kept for the redraft; never shown publicly).
  owner_request text check (owner_request is null or char_length(owner_request) <= 1000),
  status text not null default 'draft'
    check (status in ('draft', 'awaiting_owner', 'open', 'closed', 'rejected', 'expired')),
  draft_source text not null default 'ai' check (draft_source in ('ai', 'template')),
  approval_id uuid references public.owner_approvals(id) on delete set null,
  published_at timestamptz,
  owner_texted_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists job_postings_company_idx on public.job_postings (company_id, status, created_at desc);

-- ── 4. Applicants ──────────────────────────────────────────────────────────────────
create table if not exists public.job_applicants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  job_id uuid not null references public.job_postings(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  phone text not null check (char_length(phone) between 8 and 20),
  email text check (email is null or char_length(email) <= 254),
  experience text check (experience is null or char_length(experience) <= 2000),
  availability text check (availability is null or char_length(availability) <= 500),
  drivers_licence boolean,
  has_vehicle boolean,
  -- [{ question, answer }] for the job's custom questions.
  answers jsonb not null default '[]'::jsonb,
  status text not null default 'new'
    check (status in ('new', 'invited', 'interviewing', 'hired', 'declined', 'withdrawn')),
  -- AI screening against the job's stated requirements only (never protected grounds).
  score integer check (score is null or (score between 1 and 5)),
  score_reason text check (score_reason is null or char_length(score_reason) <= 300),
  screening jsonb,
  screening_source text check (screening_source is null or screening_source in ('ai', 'rules')),
  screened_at timestamptz,
  screen_attempts integer not null default 0,
  -- Confirmation text to the applicant ("we got your application").
  confirmation_status text not null default 'pending'
    check (confirmation_status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  confirmation_sent_at timestamptz,
  -- In the owner's daily digest (once).
  digest_at timestamptz,
  invite_approval_id uuid references public.owner_approvals(id) on delete set null,
  invited_at timestamptz,
  applied_count integer not null default 1,
  last_applied_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, phone),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists job_applicants_company_idx on public.job_applicants (company_id, created_at desc);
create index if not exists job_applicants_unscreened_idx on public.job_applicants (created_at) where screened_at is null;
create index if not exists job_applicants_unconfirmed_idx on public.job_applicants (created_at) where confirmation_status = 'pending';
create index if not exists job_applicants_digest_idx on public.job_applicants (company_id) where digest_at is null;

-- ── 5. Sweep claims (service role only) ────────────────────────────────────────────
create table if not exists public.recruiter_sweep_claims (
  company_id uuid not null references public.companies(id) on delete cascade,
  task text not null,
  period_key text not null,
  created_at timestamptz not null default now(),
  primary key (company_id, task, period_key)
);

-- ── RLS + grants ───────────────────────────────────────────────────────────────────
alter table public.pay_periods enable row level security;
alter table public.pay_period_events enable row level security;
alter table public.job_postings enable row level security;
alter table public.job_applicants enable row level security;
alter table public.recruiter_sweep_claims enable row level security;

-- Dates + status only: every member may see which hours are locked.
drop policy if exists "pay_periods_select" on public.pay_periods;
create policy "pay_periods_select" on public.pay_periods
  for select using (public.is_organization_member(organization_id));
drop policy if exists "pay_period_events_select" on public.pay_period_events;
create policy "pay_period_events_select" on public.pay_period_events
  for select using (public.is_organization_admin(organization_id));
drop policy if exists "job_postings_select" on public.job_postings;
create policy "job_postings_select" on public.job_postings
  for select using (public.is_organization_member(organization_id));
-- Applicants' personal information: owners/admins only.
drop policy if exists "job_applicants_select" on public.job_applicants;
create policy "job_applicants_select" on public.job_applicants
  for select using (public.is_organization_admin(organization_id));

revoke insert, update, delete on public.pay_periods, public.pay_period_events, public.job_postings, public.job_applicants from anon, authenticated;
revoke select on public.pay_periods, public.pay_period_events, public.job_postings, public.job_applicants from anon;
revoke all on public.recruiter_sweep_claims from anon, authenticated;
grant select on public.pay_periods, public.pay_period_events, public.job_postings, public.job_applicants to authenticated;
grant all on public.pay_periods, public.pay_period_events, public.job_postings, public.job_applicants, public.recruiter_sweep_claims to service_role;

drop trigger if exists pay_periods_set_updated_at on public.pay_periods;
create trigger pay_periods_set_updated_at before update on public.pay_periods
  for each row execute procedure public.touch_updated_at();
drop trigger if exists job_postings_set_updated_at on public.job_postings;
create trigger job_postings_set_updated_at before update on public.job_postings
  for each row execute procedure public.touch_updated_at();
drop trigger if exists job_applicants_set_updated_at on public.job_applicants;
create trigger job_applicants_set_updated_at before update on public.job_applicants
  for each row execute procedure public.touch_updated_at();

comment on table public.pay_periods is 'AI Recruiter pay periods (docs/ai-staff.md). Locked periods freeze their time_entries for client writes.';
comment on table public.job_postings is 'AI Recruiter job posts. Open ones are public at /s/<slug>/jobs.';
comment on table public.job_applicants is 'Applicants to job_postings, scored against the job''s stated requirements only. Owners/admins read.';
