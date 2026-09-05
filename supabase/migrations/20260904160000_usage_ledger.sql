-- Usage ledger + minutes metering (Task 6).
--
-- Every metered thing (voice minutes, SMS, email, AI tokens) is recorded ONCE in
-- usage_events, rolled up monthly by usage_monthly_v, and enforced via orgLimit /
-- orgUsageRemaining. Retell call rows also gain duration/cost columns populated from the
-- call_analyzed payload, so voice minutes and per-call cost are queryable directly.
--
-- Additive only: new columns (nullable), a new table, a new view. Nothing is dropped.

-- 1) Retell call metering columns (populated in readRetellCallFields / upsertRetellCall).
alter table public.retell_calls add column if not exists duration_ms integer;
alter table public.retell_calls add column if not exists start_timestamp timestamptz;
alter table public.retell_calls add column if not exists end_timestamp timestamptz;
alter table public.retell_calls add column if not exists call_cost_cents integer;
alter table public.retell_calls add column if not exists cost_breakdown jsonb;

-- 2) The usage ledger. One row per metered event; (provider, provider_ref, kind) is
--    unique so a duplicate webhook / retry records the event only once.
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  kind text not null check (kind in (
    'voice_minutes',
    'sms_sent',
    'sms_received',
    'email_sent',
    'ai_input_tokens',
    'ai_output_tokens',
    'ai_cache_read_tokens'
  )),
  quantity numeric not null,
  unit text not null,
  cost_cents integer,
  provider text,
  provider_ref text,
  occurred_at timestamptz not null default timezone('utc', now()),
  metadata jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (provider, provider_ref, kind)
);

comment on table public.usage_events is
  'Append-only metering ledger (Task 6). Service-role writes only; org members read. '
  'Idempotent on (provider, provider_ref, kind).';

create index usage_events_org_kind_occurred_idx
  on public.usage_events (organization_id, kind, occurred_at desc);

-- RLS: org members can READ their own usage; there is NO insert/update/delete policy,
-- so writes happen only through the service-role client (see services/usage.ts) —
-- mirroring retell_calls and the job queues.
alter table public.usage_events enable row level security;

create policy "usage_events_org_members_select"
  on public.usage_events for select
  using (public.is_organization_member(organization_id));

-- 3) Monthly rollup. security_invoker so the caller's RLS applies (no new service-role
--    surface). Months are bucketed in America/Toronto so a late-night event lands in the
--    correct local month.
create view public.usage_monthly_v
  with (security_invoker = true)
as
  select
    organization_id,
    company_id,
    (date_trunc('month', occurred_at at time zone 'America/Toronto'))::date as month,
    kind,
    sum(quantity) as quantity,
    sum(coalesce(cost_cents, 0))::bigint as cost_cents
  from public.usage_events
  group by organization_id, company_id, month, kind;
