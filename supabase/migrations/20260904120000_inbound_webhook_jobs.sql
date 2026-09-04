-- Durable-first inbound webhooks (Task 4).
--
-- A single queue for raw inbound provider webhooks (Retell, Jobber). The webhook
-- route persists the raw payload here (and, for Retell, into retell_calls) BEFORE it
-- ACKs, so nothing can be lost between the 200 and processing. The existing
-- workflow-event worker drains it each tick and dispatches by provider.
--
-- Modeled on workflow_event_jobs + its claim RPC (FOR UPDATE SKIP LOCKED, stale-lock
-- reclaim, attempt++). Service-role only: RLS is ON with NO member policies — only the
-- webhook routes (admin client) insert and only the worker (admin client) claims.
-- Additive: new table, RPC, indexes. Nothing existing is modified.

create table public.inbound_webhook_jobs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  -- Provider's own event/call id (Retell call_id, or a sha256 of the raw Jobber body).
  -- (provider, external_id) is unique so a redelivery is a no-op insert.
  external_id text not null,
  -- Nullable: an inbound webhook is received before its tenant is resolved (the worker
  -- resolves it during processing). on delete set null keeps the durable record.
  organization_id uuid references public.organizations (id) on delete set null,
  company_id uuid,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  claimed_at timestamptz,
  claimed_by text,
  last_error text,
  run_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (provider, external_id)
);

drop trigger if exists inbound_webhook_jobs_set_updated_at on public.inbound_webhook_jobs;
create trigger inbound_webhook_jobs_set_updated_at
before update on public.inbound_webhook_jobs
for each row execute procedure public.touch_updated_at();

-- Atomic claim with stale-lock reclaim — copied from claim_workflow_event_jobs and
-- adapted to this table's columns (claimed_at / claimed_by / run_at / attempts).
create or replace function public.claim_inbound_webhook_jobs(
  p_batch integer default 10,
  p_worker_id text default 'worker',
  p_stale_after_seconds integer default 900
)
returns setof public.inbound_webhook_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.inbound_webhook_jobs job
  set
    status = case when job.attempts >= job.max_attempts then 'failed' else 'pending' end,
    run_at = timezone('utc', now()),
    last_error = case
      when job.attempts >= job.max_attempts then coalesce(job.last_error, 'Worker lock expired and retries were exhausted.')
      else coalesce(job.last_error, 'Worker lock expired and the job was returned to the queue.')
    end,
    claimed_at = null,
    claimed_by = null
  where job.status = 'running'
    and job.claimed_at is not null
    and job.claimed_at <= timezone('utc', now()) - make_interval(secs => greatest(p_stale_after_seconds, 1));

  return query
  with candidates as (
    select job.id
    from public.inbound_webhook_jobs job
    where job.status = 'pending'
      and job.run_at <= timezone('utc', now())
      and job.attempts < job.max_attempts
    order by job.run_at asc, job.created_at asc
    for update skip locked
    limit greatest(p_batch, 1)
  )
  update public.inbound_webhook_jobs job
  set
    status = 'running',
    attempts = job.attempts + 1,
    claimed_at = timezone('utc', now()),
    claimed_by = p_worker_id,
    last_error = null
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

grant execute on function public.claim_inbound_webhook_jobs(integer, text, integer) to service_role;

-- RLS: service-role only (no member policies). The webhook routes + worker use the
-- admin client, which bypasses RLS; anon/tenant clients can neither read nor write.
alter table public.inbound_webhook_jobs enable row level security;

create index if not exists inbound_webhook_jobs_status_run_at_idx
  on public.inbound_webhook_jobs (status, run_at asc, created_at asc);
create index if not exists inbound_webhook_jobs_running_claimed_idx
  on public.inbound_webhook_jobs (status, claimed_at asc)
  where status = 'running';
create index if not exists inbound_webhook_jobs_org_created_idx
  on public.inbound_webhook_jobs (organization_id, created_at desc);
