-- Revenue attribution (Task 14): "Revenue captured by EmpireVu" — one row per approved or
-- paid quote, tagged with its first-touch source/channel and whether voice-AI / automation
-- touched the contact before it closed. All security_invoker, so the caller's RLS applies
-- (no new service-role surface).
--
-- ── paid_cents (traced, not invented) ────────────────────────────────────────
-- The ONLY event that marks a quote paid is Stripe `checkout.session.completed` on the
-- company's CONNECTED account, handled by markQuoteDepositPaid in
-- src/server/services/quotes/checkout.ts (sets quotes.deposit_paid_at + status
-- 'deposit_paid'). No other Stripe event is counted, and this task adds none. paid_cents is
-- therefore the deposit that was charged — coalesce(approved_deposit_cents, deposit_cents) —
-- and only when deposit_paid_at is not null.
--
-- ── first_touch (deterministic) ──────────────────────────────────────────────
-- The EARLIEST touch on the quote's contact across three sources:
--   (1) a raw_leads row          → channel 'web',   source = coalesce(source, source_site, 'web')
--   (2) an inbound retell_calls  → channel 'voice', source 'retell'
--   (3) an inbound message_log   → channel = sms|email, source = the message channel
-- On an exact-timestamp tie, raw_leads wins (rank 0 < 1 < 2). If the quote has no contact or
-- no touches, first_touch is the contact's own created_at with source 'manual'.
--
-- ── involvement ──────────────────────────────────────────────────────────────
-- voice_ai_involved: an inbound/any retell_calls row for the contact at or before close.
-- automation_involved: a COMPLETED workflow_runs row whose trigger event targeted the
-- contact (workflow_runs.trigger_event_id → activity_events entity_type='contact'), at or
-- before close. "close" = coalesce(approved_at, deposit_paid_at). Persona-agnostic names by
-- design (an owner's front-desk employee may be renamed; the SQL never is).

-- Supporting indexes for the per-contact lookups + period filters.
create index if not exists raw_leads_org_contact_idx on public.raw_leads (organization_id, contact_id);
create index if not exists retell_calls_org_contact_idx on public.retell_calls (organization_id, contact_id);
create index if not exists workflow_runs_trigger_event_idx on public.workflow_runs (trigger_event_id);
create index if not exists quotes_org_company_approved_idx on public.quotes (organization_id, company_id, approved_at);
create index if not exists quotes_org_company_paid_idx on public.quotes (organization_id, company_id, deposit_paid_at);

create or replace view public.revenue_attribution_v
with (security_invoker = true)
as
  select
    q.organization_id,
    q.company_id,
    q.id as quote_id,
    q.contact_id,
    q.auto_generated,
    coalesce(ft.source, 'manual') as first_touch_source,
    coalesce(ft.channel, 'manual') as first_touch_channel,
    coalesce(ft.touched_at, q.created_at) as first_touch_at,
    exists (
      select 1 from public.retell_calls rc
      where rc.contact_id = q.contact_id and rc.organization_id = q.organization_id
        and coalesce(rc.received_at, rc.created_at) <= coalesce(q.approved_at, q.deposit_paid_at)
    ) as voice_ai_involved,
    exists (
      select 1
      from public.workflow_runs wr
      join public.activity_events ae on ae.id = wr.trigger_event_id
      where wr.organization_id = q.organization_id
        and wr.status = 'completed'
        and ae.entity_type = 'contact'
        and ae.entity_id = q.contact_id
        and wr.created_at <= coalesce(q.approved_at, q.deposit_paid_at)
    ) as automation_involved,
    q.approved_total_cents as approved_cents,
    case when q.deposit_paid_at is not null then coalesce(q.approved_deposit_cents, q.deposit_cents) else 0 end as paid_cents,
    q.approved_at,
    q.deposit_paid_at as paid_at
  from public.quotes q
  left join lateral (
    select touches.src as source, touches.chan as channel, touches.ts as touched_at
    from (
      select rl.created_at as ts, 0 as rnk, coalesce(rl.source, rl.source_site, 'web') as src, 'web' as chan
        from public.raw_leads rl
        where rl.contact_id = q.contact_id and rl.organization_id = q.organization_id
      union all
      select coalesce(rc.received_at, rc.created_at) as ts, 1 as rnk, 'retell' as src, 'voice' as chan
        from public.retell_calls rc
        where rc.contact_id = q.contact_id and rc.organization_id = q.organization_id
          and coalesce(rc.direction, 'inbound') = 'inbound'
      union all
      select ml.created_at as ts, 2 as rnk, ml.channel as src, case when ml.channel = 'email' then 'email' else 'sms' end as chan
        from public.message_log ml
        where ml.contact_id = q.contact_id and ml.organization_id = q.organization_id
          and ml.direction = 'inbound'
    ) touches
    where touches.ts is not null
    order by touches.ts asc, touches.rnk asc
    limit 1
  ) ft on true
  where q.approved_at is not null or q.deposit_paid_at is not null;

-- Aggregate for the dashboard card + report header. A quote is attributed to the period
-- containing coalesce(approved_at, paid_at). Also sums completed workflow_runs time saved.
create or replace function public.ui_attribution_summary(
  p_org_id uuid,
  p_company_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  quotes_count integer,
  approved_cents_total bigint,
  paid_cents_total bigint,
  voice_ai_count integer,
  voice_ai_approved_cents bigint,
  voice_ai_paid_cents bigint,
  automation_count integer,
  automation_approved_cents bigint,
  automation_paid_cents bigint,
  estimated_time_saved_seconds bigint,
  by_source jsonb,
  by_channel jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with cohort as (
    select *
    from public.revenue_attribution_v r
    where r.organization_id = p_org_id
      and (p_company_id is null or r.company_id = p_company_id)
      and (p_from is null or coalesce(r.approved_at, r.paid_at) >= p_from)
      and (p_to is null or coalesce(r.approved_at, r.paid_at) < p_to)
  )
  select
    count(*)::integer,
    coalesce(sum(approved_cents), 0)::bigint,
    coalesce(sum(paid_cents), 0)::bigint,
    count(*) filter (where voice_ai_involved)::integer,
    coalesce(sum(approved_cents) filter (where voice_ai_involved), 0)::bigint,
    coalesce(sum(paid_cents) filter (where voice_ai_involved), 0)::bigint,
    count(*) filter (where automation_involved)::integer,
    coalesce(sum(approved_cents) filter (where automation_involved), 0)::bigint,
    coalesce(sum(paid_cents) filter (where automation_involved), 0)::bigint,
    (
      select coalesce(sum(wr.time_saved_seconds), 0)::bigint
      from public.workflow_runs wr
      where wr.organization_id = p_org_id
        and (p_company_id is null or wr.company_id = p_company_id)
        and wr.status = 'completed'
        and (p_from is null or wr.created_at >= p_from)
        and (p_to is null or wr.created_at < p_to)
    ),
    coalesce((
      select jsonb_object_agg(s.source, s.agg) from (
        select first_touch_source as source,
          jsonb_build_object('count', count(*), 'approved_cents', coalesce(sum(approved_cents), 0), 'paid_cents', coalesce(sum(paid_cents), 0)) as agg
        from cohort group by first_touch_source
      ) s
    ), '{}'::jsonb),
    coalesce((
      select jsonb_object_agg(c.channel, c.agg) from (
        select first_touch_channel as channel,
          jsonb_build_object('count', count(*), 'approved_cents', coalesce(sum(approved_cents), 0), 'paid_cents', coalesce(sum(paid_cents), 0)) as agg
        from cohort group by first_touch_channel
      ) c
    ), '{}'::jsonb)
  from cohort;
$$;

grant execute on function public.ui_attribution_summary(uuid, uuid, timestamptz, timestamptz) to authenticated;
