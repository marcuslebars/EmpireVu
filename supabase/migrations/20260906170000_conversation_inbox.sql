-- Unified conversation inbox (Task 12): per-user read-state + two read models.
--
-- 1) contact_read_state — per (contact, user) last-read marker, drives the "unread" flag.
-- 2) ui_inbox_v — org-level, one row per contact with a conversation, sortable by
--    needs_reply then recency, filterable by company.
-- 3) ui_conversation_thread(...) — keyset-paginated unified stream for one contact,
--    merging message_log, retell_calls, contact.*/quote.* activity_events, ai_drafts,
--    and raw_leads.
--
-- Both read models are security_invoker (Task 3 convention): row visibility is the
-- caller's own RLS on the underlying tables — no new service-role surface.

-- ── 1) contact_read_state ─────────────────────────────────────────────────────
create table if not exists public.contact_read_state (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default timezone('utc', now()),
  primary key (contact_id, profile_id)
);

create index if not exists contact_read_state_org_profile_idx
  on public.contact_read_state (organization_id, profile_id);

alter table public.contact_read_state enable row level security;

-- Each member manages only their OWN read markers within their org.
create policy "contact_read_state_self_select"
  on public.contact_read_state for select
  using (public.is_organization_member(organization_id) and profile_id = auth.uid());

create policy "contact_read_state_self_insert"
  on public.contact_read_state for insert
  with check (public.is_organization_member(organization_id) and profile_id = auth.uid());

create policy "contact_read_state_self_update"
  on public.contact_read_state for update
  using (public.is_organization_member(organization_id) and profile_id = auth.uid())
  with check (public.is_organization_member(organization_id) and profile_id = auth.uid());

-- ── 2) ui_inbox_v ─────────────────────────────────────────────────────────────
create or replace view public.ui_inbox_v
with (security_invoker = true)
as
  with events as (
    select ml.organization_id, ml.contact_id, ml.direction, ml.created_at as occurred_at,
           ml.channel, ml.body
    from public.message_log ml
    where ml.contact_id is not null
    union all
    select rc.organization_id, rc.contact_id, coalesce(rc.direction, 'inbound') as direction,
           coalesce(rc.received_at, rc.created_at) as occurred_at,
           'voice' as channel, rc.call_summary as body
    from public.retell_calls rc
    where rc.contact_id is not null and rc.organization_id is not null
  ),
  agg as (
    select organization_id, contact_id,
           max(occurred_at) filter (where direction = 'inbound') as last_inbound_at,
           max(occurred_at) filter (where direction = 'outbound') as last_outbound_at,
           max(occurred_at) as last_activity_at
    from events
    group by organization_id, contact_id
  ),
  last_evt as (
    select distinct on (e.organization_id, e.contact_id)
           e.organization_id, e.contact_id, e.channel, e.body
    from events e
    order by e.organization_id, e.contact_id, e.occurred_at desc
  )
  select
    a.organization_id,
    a.contact_id,
    c.company_id,
    trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) as contact_name,
    c.email as contact_email,
    c.phone as contact_phone,
    co.name as company_name,
    a.last_inbound_at,
    a.last_outbound_at,
    a.last_activity_at,
    (a.last_inbound_at is not null
      and (a.last_outbound_at is null or a.last_inbound_at > a.last_outbound_at)) as needs_reply,
    (a.last_inbound_at is not null
      and a.last_inbound_at > coalesce(crs.last_read_at, 'epoch'::timestamptz)) as unread,
    le.channel,
    left(coalesce(le.body, ''), 140) as snippet,
    lower(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '') || ' '
      || coalesce(c.email, '') || ' ' || coalesce(c.phone, '')) as search_text
  from agg a
  join public.contacts c on c.id = a.contact_id and c.organization_id = a.organization_id
  left join public.companies co on co.id = c.company_id and co.organization_id = a.organization_id
  left join public.contact_read_state crs
    on crs.contact_id = a.contact_id and crs.profile_id = auth.uid()
  left join last_evt le on le.organization_id = a.organization_id and le.contact_id = a.contact_id;

-- ── 3) ui_conversation_thread(...) ────────────────────────────────────────────
create or replace function public.ui_conversation_thread(
  p_org_id uuid,
  p_contact_id uuid,
  p_before_ts timestamptz default null,
  p_limit integer default 50
)
returns table (
  id text,
  kind text,
  occurred_at timestamptz,
  direction text,
  channel text,
  title text,
  body text,
  status text,
  metadata jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  select * from (
    -- Messages (SMS/email in + out) — the source of truth for message content.
    select
      ml.id::text as id,
      'message'::text as kind,
      ml.created_at as occurred_at,
      ml.direction,
      ml.channel,
      null::text as title,
      ml.body,
      ml.status,
      jsonb_build_object('from', ml.from_addr, 'to', ml.to_addr, 'provider', ml.provider,
        'providerRef', ml.provider_ref, 'subject', ml.subject) as metadata
    from public.message_log ml
    where ml.organization_id = p_org_id and ml.contact_id = p_contact_id

    union all
    -- Voice calls: Marina summary + transcript (the UI expands to these).
    select
      rc.id::text,
      'call'::text,
      coalesce(rc.received_at, rc.created_at),
      coalesce(rc.direction, 'inbound'),
      'voice'::text,
      rc.call_summary,
      null::text,
      case when rc.call_successful is true then 'completed'
           when rc.in_voicemail is true then 'voicemail'
           else null end,
      jsonb_build_object('callId', rc.call_id, 'durationMs', rc.duration_ms,
        'inVoicemail', rc.in_voicemail, 'isUrgent', rc.is_urgent, 'sentiment', rc.user_sentiment,
        'summary', rc.call_summary, 'transcript', rc.transcript)
    from public.retell_calls rc
    where rc.organization_id = p_org_id and rc.contact_id = p_contact_id

    union all
    -- contact.* / quote.* timeline events (the SMS message-emit markers are excluded —
    -- message_log already carries those with the real body).
    select
      ae.id::text,
      'event'::text,
      ae.occurred_at,
      null::text,
      (ae.metadata_json ->> 'channel'),
      ae.event_type,
      null::text,
      null::text,
      ae.metadata_json
    from public.activity_events ae
    where ae.organization_id = p_org_id
      and ae.entity_id = p_contact_id
      and (ae.event_type like 'contact.%' or ae.event_type like 'quote.%')
      and ae.event_type not in ('contact.sms_sent', 'contact.sms_received', 'contact.email_sent')

    union all
    -- AI drafts (a proposed reply awaiting review/send).
    select
      ad.id::text,
      'draft'::text,
      ad.created_at,
      'outbound'::text,
      null::text,
      'AI draft'::text,
      coalesce(ad.email_subject, left(coalesce(ad.sms_body, ''), 140)),
      case when ad.email_status = 'sent' or ad.sms_status = 'sent' then 'sent' else 'draft' end,
      jsonb_build_object('draftId', ad.id, 'emailStatus', ad.email_status, 'smsStatus', ad.sms_status)
    from public.ai_drafts ad
    where ad.organization_id = p_org_id and ad.contact_id = p_contact_id

    union all
    -- Inbound web-form leads.
    select
      rl.id::text,
      'lead'::text,
      coalesce(rl.received_at, rl.created_at),
      'inbound'::text,
      'form'::text,
      coalesce(rl.form_type, 'Web form'),
      null::text,
      case when rl.matched then 'matched' else 'unmatched' end,
      jsonb_build_object('source', rl.source, 'sourceSite', rl.source_site,
        'formType', rl.form_type, 'needsAttention', rl.needs_attention)
    from public.raw_leads rl
    where rl.organization_id = p_org_id and rl.contact_id = p_contact_id
  ) thread
  where p_before_ts is null or thread.occurred_at < p_before_ts
  order by thread.occurred_at desc
  limit greatest(coalesce(p_limit, 50), 1);
$$;

grant execute on function public.ui_conversation_thread(uuid, uuid, timestamptz, integer) to authenticated;
