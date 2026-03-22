create type public.workflow_event_job_status as enum ('pending', 'running', 'completed', 'failed');

create table public.workflow_event_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  activity_event_id uuid not null,
  status public.workflow_event_job_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  available_at timestamptz not null default timezone('utc', now()),
  last_attempted_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, activity_event_id),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null,
  foreign key (activity_event_id, organization_id)
    references public.activity_events (id, organization_id)
    on delete cascade
);

create or replace function public.set_workflow_event_job_scope()
returns trigger
language plpgsql
as $$
declare
  event_company_id uuid;
begin
  select activity_event.company_id
  into event_company_id
  from public.activity_events activity_event
  where activity_event.organization_id = new.organization_id
    and activity_event.id = new.activity_event_id;

  new.company_id := coalesce(new.company_id, event_company_id);

  if event_company_id is not null and new.company_id is distinct from event_company_id then
    raise exception 'Workflow event job company_id must match the activity event company.';
  end if;

  return new;
end;
$$;

drop trigger if exists workflow_event_jobs_set_updated_at on public.workflow_event_jobs;
create trigger workflow_event_jobs_set_updated_at
before update on public.workflow_event_jobs
for each row execute procedure public.touch_updated_at();

drop trigger if exists workflow_event_jobs_set_company_scope on public.workflow_event_jobs;
create trigger workflow_event_jobs_set_company_scope
before insert or update on public.workflow_event_jobs
for each row execute procedure public.set_workflow_event_job_scope();

create or replace function public.claim_workflow_event_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_stale_after_seconds integer default 900
)
returns setof public.workflow_event_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.workflow_event_jobs job
  set
    status = case
      when job.attempt_count >= job.max_attempts then 'failed'::public.workflow_event_job_status
      else 'pending'::public.workflow_event_job_status
    end,
    available_at = timezone('utc', now()),
    completed_at = case
      when job.attempt_count >= job.max_attempts then timezone('utc', now())
      else null
    end,
    last_error = case
      when job.attempt_count >= job.max_attempts then coalesce(job.last_error, 'Worker lock expired and retries were exhausted.')
      else coalesce(job.last_error, 'Worker lock expired and the job was returned to the queue.')
    end,
    locked_at = null,
    locked_by = null
  where job.status = 'running'
    and job.locked_at is not null
    and job.locked_at <= timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1));

  return query
  with candidates as (
    select job.id
    from public.workflow_event_jobs job
    where job.status = 'pending'
      and job.available_at <= timezone('utc', now())
      and job.attempt_count < job.max_attempts
    order by job.available_at asc, job.created_at asc
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update public.workflow_event_jobs job
  set
    status = 'running',
    attempt_count = job.attempt_count + 1,
    last_attempted_at = timezone('utc', now()),
    locked_at = timezone('utc', now()),
    locked_by = p_worker_id,
    started_at = coalesce(job.started_at, timezone('utc', now())),
    completed_at = null,
    last_error = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

grant execute on function public.claim_workflow_event_jobs(text, integer, integer) to authenticated, service_role;

alter table public.workflow_event_jobs enable row level security;

create policy "workflow_event_jobs_org_members_select"
on public.workflow_event_jobs
for select
using (public.is_organization_member(organization_id));

create policy "workflow_event_jobs_org_members_insert"
on public.workflow_event_jobs
for insert
with check (public.is_organization_member(organization_id));

create policy "workflow_event_jobs_org_members_update"
on public.workflow_event_jobs
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "workflow_event_jobs_org_members_delete"
on public.workflow_event_jobs
for delete
using (public.is_organization_member(organization_id));

create unique index if not exists workflow_runs_org_workflow_trigger_event_unique
  on public.workflow_runs (organization_id, workflow_id, trigger_event_id)
  where trigger_event_id is not null;

create index if not exists workflow_event_jobs_org_status_available_idx
  on public.workflow_event_jobs (organization_id, status, available_at asc, created_at asc);

create index if not exists workflow_event_jobs_org_event_idx
  on public.workflow_event_jobs (organization_id, activity_event_id);

create index if not exists workflow_event_jobs_running_locked_idx
  on public.workflow_event_jobs (status, locked_at asc)
  where status = 'running';