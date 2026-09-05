-- Workflow engine v2 part 2: delays, time triggers, scheduling (Task 9).
--
-- Durable waits: a run can pause mid-sequence (status 'waiting' + resume_at + the step to
-- resume at) and the worker resumes it when due. A per-minute scheduler materializes
-- workflow_schedule_ticks for time-based triggers and the worker drains them.
--
-- Additive: new enum value, new nullable columns, a new table, two claim RPCs.

-- 1) 'waiting' run status. Safe in this migration: the value is only referenced inside
--    function BODIES (stored text, not evaluated at creation) and in a NON-partial index,
--    never in an index predicate — so there's no "unsafe use of new value" in-tx error.
alter type public.workflow_run_status add value if not exists 'waiting';

-- 2) Durable-wait columns on workflow_runs.
alter table public.workflow_runs add column if not exists current_step_index integer not null default 0;
alter table public.workflow_runs add column if not exists resume_at timestamptz;
create index if not exists workflow_runs_status_resume_idx on public.workflow_runs (status, resume_at);

-- Claim due waiting runs (status flip waiting→running is the claim; SKIP LOCKED). Also
-- reclaims resumes that got stuck 'running' past the stale window (a crashed worker).
create or replace function public.claim_waiting_workflow_runs(
  p_batch integer default 10,
  p_stale_after_seconds integer default 900
)
returns setof public.workflow_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.workflow_runs r
  set status = 'waiting'
  where r.status = 'running'
    and r.resume_at is not null
    and r.resume_at <= timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1));

  return query
  with candidates as (
    select r.id
    from public.workflow_runs r
    where r.status = 'waiting'
      and r.resume_at is not null
      and r.resume_at <= timezone('utc', now())
    order by r.resume_at asc
    for update skip locked
    limit greatest(p_batch, 1)
  )
  update public.workflow_runs r
  set status = 'running'
  from candidates
  where r.id = candidates.id
  returning r.*;
end;
$$;

grant execute on function public.claim_waiting_workflow_runs(integer, integer) to service_role;

-- 3) Per-company timezone for local-time schedules (default applied in code: falls back
--    to BUSINESS_TIMEZONE when null).
alter table public.companies add column if not exists timezone text;

-- 4) Schedule ticks — one row per (workflow, slot); unique makes the scheduler idempotent.
create table public.workflow_schedule_ticks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  workflow_id uuid not null,
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  claimed_at timestamptz,
  claimed_by text,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (workflow_id, scheduled_for)
);

create index workflow_schedule_ticks_due_idx on public.workflow_schedule_ticks (status, scheduled_for);

-- Service-role only (no member policies) — the scheduler/worker use the admin client.
alter table public.workflow_schedule_ticks enable row level security;

create or replace function public.claim_workflow_schedule_ticks(
  p_batch integer default 50,
  p_worker_id text default 'worker',
  p_stale_after_seconds integer default 300
)
returns setof public.workflow_schedule_ticks
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.workflow_schedule_ticks t
  set status = 'pending', claimed_at = null, claimed_by = null
  where t.status = 'running'
    and t.claimed_at is not null
    and t.claimed_at <= timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1));

  return query
  with candidates as (
    select t.id
    from public.workflow_schedule_ticks t
    where t.status = 'pending'
      and t.scheduled_for <= timezone('utc', now())
    order by t.scheduled_for asc
    for update skip locked
    limit greatest(p_batch, 1)
  )
  update public.workflow_schedule_ticks t
  set status = 'running', claimed_at = timezone('utc', now()), claimed_by = p_worker_id
  from candidates
  where t.id = candidates.id
  returning t.*;
end;
$$;

grant execute on function public.claim_workflow_schedule_ticks(integer, text, integer) to service_role;
