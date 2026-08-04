-- Phase 1 billing layer: Stripe subscriptions, the webhook event ledger + its
-- job queue, and per-org feature flags.
--
-- ADDITIVE ONLY. New columns and new tables; nothing existing is altered,
-- renamed, or dropped. All existing organizations default to plan 'internal'
-- (the house tenants — A1 brands, boatnames, blairspm), which is exempt from all
-- billing enforcement and feature gating, so their behavior is unchanged.
--
-- Mirrors existing patterns:
--   * raw_leads               -> durable, service-role-written, org-member-read log
--   * workflow_event_jobs     -> the Postgres job queue (locks + attempts)
--   * claim_workflow_event_jobs -> FOR UPDATE SKIP LOCKED batch claim + stale recovery
--   * touch_updated_at()      -> updated_at trigger
--   * is_organization_member() -> tenant RLS
--
-- Rollback: supabase/rollback/20260804120000_add_billing.down.sql

-- ── organizations: billing columns ──────────────────────────────────────────
-- NOTE: billing_email already exists (citext) from the initial migration — it is
-- REUSED, never re-added (additive-only). Only the four new columns are added.
alter table public.organizations
  add column stripe_customer_id text,
  add column plan text not null default 'internal',
  add column subscription_status text not null default 'none',
  add column trial_ends_at timestamptz;

alter table public.organizations
  add constraint organizations_stripe_customer_id_key unique (stripe_customer_id);

alter table public.organizations
  add constraint organizations_plan_check
    check (plan in ('internal', 'launch', 'operate', 'front_desk'));

alter table public.organizations
  add constraint organizations_subscription_status_check
    check (subscription_status in ('none', 'trialing', 'active', 'past_due', 'canceled'));

-- ── subscriptions ───────────────────────────────────────────────────────────
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  stripe_subscription_id text not null unique,
  plan text not null
    check (plan in ('internal', 'launch', 'operate', 'front_desk')),
  status text not null
    check (status in ('none', 'trialing', 'active', 'past_due', 'canceled')),
  current_period_end timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index subscriptions_org_created_idx
  on public.subscriptions (organization_id, created_at desc);

create trigger subscriptions_set_updated_at
before update on public.subscriptions
for each row execute procedure public.touch_updated_at();

alter table public.subscriptions enable row level security;

-- Read: org members see their own org's subscriptions. Write: service role only
-- (the billing worker), which bypasses RLS — mirrors raw_leads. No insert/update
-- /delete policy for tenants.
create policy "subscriptions_org_members_select"
on public.subscriptions
for select
using (public.is_organization_member(organization_id));

-- ── billing_events (the idempotency ledger) ─────────────────────────────────
-- Every Stripe webhook event is persisted here BEFORE processing (durable-write
-- first). organization_id is nullable: some events arrive before we can resolve
-- the org (unknown customer). stripe_event_id unique => idempotent receipt.
create table public.billing_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete set null,
  stripe_event_id text not null unique,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz
);

create index billing_events_unprocessed_idx
  on public.billing_events (received_at asc)
  where processed_at is null;
create index billing_events_org_received_idx
  on public.billing_events (organization_id, received_at desc);

alter table public.billing_events enable row level security;

-- Row visibility: org members can see their own org's event rows. Unresolved
-- events (organization_id is null) are visible to the service role only, since
-- is_organization_member(null) is false.
create policy "billing_events_org_members_select"
on public.billing_events
for select
using (public.is_organization_member(organization_id));

-- Column privacy: the raw Stripe payload can contain data a tenant shouldn't see
-- (other customers, internal ids, PII). Revoke tenant SELECT on the whole row,
-- then re-grant only the non-payload metadata columns to authenticated. The
-- service role keeps its default table grant (payload included) and bypasses RLS.
revoke select on public.billing_events from anon, authenticated;
grant select (id, organization_id, stripe_event_id, type, received_at, processed_at)
  on public.billing_events to authenticated;

-- ── billing_event_jobs (the queue over the ledger) ──────────────────────────
-- Mirrors workflow_event_jobs. One job per ledger row (unique billing_event_id).
-- Service-role only (internal plumbing): RLS on with no tenant policies.
create table public.billing_event_jobs (
  id uuid primary key default gen_random_uuid(),
  billing_event_id uuid not null unique references public.billing_events (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
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
  updated_at timestamptz not null default timezone('utc', now())
);

create index billing_event_jobs_claim_idx
  on public.billing_event_jobs (status, available_at asc, created_at asc);
create index billing_event_jobs_running_locked_idx
  on public.billing_event_jobs (status, locked_at asc)
  where status = 'running';

create trigger billing_event_jobs_set_updated_at
before update on public.billing_event_jobs
for each row execute procedure public.touch_updated_at();

alter table public.billing_event_jobs enable row level security;

-- ── feature_flags (per-org overrides of plan defaults) ──────────────────────
create table public.feature_flags (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  feature text not null,
  enabled boolean not null default true,
  limit_value integer,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, feature)
);

create trigger feature_flags_set_updated_at
before update on public.feature_flags
for each row execute procedure public.touch_updated_at();

alter table public.feature_flags enable row level security;

-- Read: org members read their own org's flags (UI gating state). Write: service
-- role only (platform-managed overrides).
create policy "feature_flags_org_members_select"
on public.feature_flags
for select
using (public.is_organization_member(organization_id));

-- ── record_billing_event: atomic durable-write + enqueue ────────────────────
-- Called by the Stripe webhook (service role). Inserts the ledger row and, only
-- if it is genuinely new (not a duplicate delivery), enqueues a processing job —
-- both in ONE transaction, so a crash can never persist the event without a job,
-- nor a job without the event. Returns the new billing_events.id, or null when
-- the event was already received (idempotent no-op -> webhook returns 200).
create or replace function public.record_billing_event(
  p_stripe_event_id text,
  p_type text,
  p_payload jsonb,
  p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
begin
  insert into public.billing_events (stripe_event_id, type, payload, organization_id)
  values (p_stripe_event_id, p_type, p_payload, p_organization_id)
  on conflict (stripe_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Duplicate delivery: the event is already recorded. Do not re-enqueue.
    return null;
  end if;

  insert into public.billing_event_jobs (billing_event_id)
  values (v_event_id);

  return v_event_id;
end;
$$;

grant execute on function public.record_billing_event(text, text, jsonb, uuid) to service_role;

-- ── claim_billing_event_jobs: atomic batch claim ────────────────────────────
-- Verbatim mirror of claim_workflow_event_jobs: recover stale locks, then claim
-- a batch of pending jobs via FOR UPDATE SKIP LOCKED, incrementing attempt_count
-- atomically at claim time. Terminal 'failed' is the de-facto dead-letter.
create or replace function public.claim_billing_event_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_stale_after_seconds integer default 900
)
returns setof public.billing_event_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.billing_event_jobs job
  set
    status = case
      when job.attempt_count >= job.max_attempts then 'failed'
      else 'pending'
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
    from public.billing_event_jobs job
    where job.status = 'pending'
      and job.available_at <= timezone('utc', now())
      and job.attempt_count < job.max_attempts
    order by job.available_at asc, job.created_at asc
    for update skip locked
    limit greatest(p_limit, 1)
  )
  update public.billing_event_jobs job
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

grant execute on function public.claim_billing_event_jobs(text, integer, integer) to service_role;
