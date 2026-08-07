-- Jobber quote sync: a per-org OAuth connection store + an outbox/job queue that
-- mirrors workflow_event_jobs. Everything is gated at the app layer by
-- JOBBER_SYNC_ENABLED (default off). Writes are service-role only (worker + intake
-- use the admin client); tokens are secrets and are never exposed to org members.

-- ── OAuth connection (rotated tokens) ────────────────────────────────────────
create table public.jobber_connections (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  refresh_lock_at timestamptz,              -- short-lived mutex so token refreshes serialize
  scope text,
  jobber_account_name text,
  connected_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists jobber_connections_set_updated_at on public.jobber_connections;
create trigger jobber_connections_set_updated_at
before update on public.jobber_connections
for each row execute procedure public.touch_updated_at();

-- RLS on, NO member policies: refresh/access tokens are secrets. Only the
-- service-role (RLS-bypassing) admin client touches this table.
alter table public.jobber_connections enable row level security;

-- ── Sync job queue (outbox) ──────────────────────────────────────────────────
create type public.jobber_sync_job_status as enum (
  'pending', 'running', 'completed', 'failed', 'manual_review'
);

create table public.jobber_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  lead_id text not null,                    -- raw_leads.lead_id — the idempotency key
  contact_id uuid,
  payload jsonb not null default '{}'::jsonb, -- contact + line items + asset + locality + formType
  status public.jobber_sync_job_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  available_at timestamptz not null default timezone('utc', now()),
  last_attempted_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  completed_at timestamptz,
  jobber_client_id text,                    -- stored on success — dedupe/idempotency
  jobber_quote_id text,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (lead_id),                         -- idempotency: exactly one sync job per lead
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null
);

drop trigger if exists jobber_sync_jobs_set_updated_at on public.jobber_sync_jobs;
create trigger jobber_sync_jobs_set_updated_at
before update on public.jobber_sync_jobs
for each row execute procedure public.touch_updated_at();

-- Atomic claim with stale-lock reclaim (mirrors claim_workflow_event_jobs).
-- Exhausted retries land in manual_review (surfaced, never silently dropped).
create or replace function public.claim_jobber_sync_jobs(
  p_worker_id text,
  p_limit integer default 5,
  p_stale_after_seconds integer default 900
)
returns setof public.jobber_sync_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.jobber_sync_jobs job
  set
    status = case
      when job.attempt_count >= job.max_attempts then 'manual_review'::public.jobber_sync_job_status
      else 'pending'::public.jobber_sync_job_status
    end,
    available_at = timezone('utc', now()),
    completed_at = case
      when job.attempt_count >= job.max_attempts then timezone('utc', now()) else null end,
    last_error = coalesce(job.last_error, 'Worker lock expired and the job was returned to the queue.'),
    locked_at = null,
    locked_by = null
  where job.status = 'running'
    and job.locked_at is not null
    and job.locked_at <= timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1));

  return query
  with candidates as (
    select job.id
    from public.jobber_sync_jobs job
    where job.status = 'pending'
      and job.available_at <= timezone('utc', now())
      and job.attempt_count < job.max_attempts
    order by job.available_at asc, job.created_at asc
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update public.jobber_sync_jobs job
  set
    status = 'running',
    attempt_count = job.attempt_count + 1,
    last_attempted_at = timezone('utc', now()),
    locked_at = timezone('utc', now()),
    locked_by = p_worker_id,
    started_at = coalesce(job.started_at, timezone('utc', now())),
    completed_at = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

grant execute on function public.claim_jobber_sync_jobs(text, integer, integer) to service_role;

alter table public.jobber_sync_jobs enable row level security;

-- Read-only visibility for org members (e.g. an ops/needs-attention view);
-- all writes go through the service-role admin client (worker + intake).
create policy "jobber_sync_jobs_org_members_select"
on public.jobber_sync_jobs
for select
using (public.is_organization_member(organization_id));

create index if not exists jobber_sync_jobs_status_available_idx
  on public.jobber_sync_jobs (status, available_at asc, created_at asc);
create index if not exists jobber_sync_jobs_running_locked_idx
  on public.jobber_sync_jobs (status, locked_at asc)
  where status = 'running';
create index if not exists jobber_sync_jobs_org_created_idx
  on public.jobber_sync_jobs (organization_id, created_at desc);
create index if not exists jobber_sync_jobs_manual_review_idx
  on public.jobber_sync_jobs (status)
  where status = 'manual_review';
