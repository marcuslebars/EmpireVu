-- Read models for the /ui/* dashboard endpoints (Task 3).
--
-- Replaces the in-memory joins in src/server/services/live-data.ts (which loaded
-- whole tables via listAllRows and joined/aggregated in JS — O(n^2), and silently
-- truncated at PostgREST's 1,000-row cap) with purpose-built views and
-- `security invoker` functions. `security invoker` means the caller's RLS applies,
-- so these read models are exactly as tenant-safe as a direct table select — no new
-- service-role surface.
--
-- Everything here is additive: new extension, indexes, a generated column, views and
-- functions. No existing table, column, policy, or row is modified.
--
-- Naming: `ui_*_v` = view (list surfaces), `ui_*(...)` = function (parameterised /
-- keyset-paginated surfaces). Each returns exactly the columns the existing
-- TypeScript response shape needs; the live-data.ts functions map 1:1 onto them.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_trgm;

-- ─────────────────────────────────────────────────────────────────────────────
-- Revenue helper — mirrors extractValueCents() in live-data.ts: read the first of
-- value_cents / valueCents / revenue_cents / revenueCents that parses as a finite
-- number, else null. IMMUTABLE + safe: a non-numeric string yields null (never an
-- error), matching the JS Number()/isFinite guard.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ui_value_cents(p jsonb)
returns numeric
language sql
immutable
as $$
  select coalesce(
    (p->>'value_cents'),
    (p->>'valueCents'),
    (p->>'revenue_cents'),
    (p->>'revenueCents')
  )::numeric
  from (select 1) as _
  where coalesce(
    (p->>'value_cents'),
    (p->>'valueCents'),
    (p->>'revenue_cents'),
    (p->>'revenueCents')
  ) ~ '^-?\d+(\.\d+)?$';
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Search — contacts.search_text (name/email/phone), trigram-indexed for ilike.
-- Replaces JS substring filtering (matchesSearch) in the CRM list.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.contacts
  add column if not exists search_text text
  generated always as (
    lower(
      coalesce(first_name, '') || ' ' ||
      coalesce(last_name, '') || ' ' ||
      coalesce(email, '') || ' ' ||
      coalesce(phone, '')
    )
  ) stored;

create index if not exists contacts_search_text_trgm_idx
  on public.contacts using gin (search_text gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes for the read-model joins/filters (Task 3, step 3).
-- ─────────────────────────────────────────────────────────────────────────────
create index if not exists activity_events_entity_occurred_idx
  on public.activity_events (organization_id, entity_type, entity_id, occurred_at desc);
create index if not exists activity_events_related_entity_occurred_idx
  on public.activity_events (organization_id, related_entity_type, related_entity_id, occurred_at desc);
create index if not exists activity_events_company_occurred_idx
  on public.activity_events (organization_id, company_id, occurred_at desc);
create index if not exists bookings_contact_scheduled_idx
  on public.bookings (organization_id, contact_id, scheduled_for);
create index if not exists tasks_contact_status_idx
  on public.tasks (organization_id, contact_id, status);
create index if not exists quotes_contact_status_idx
  on public.quotes (organization_id, contact_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- ui_dashboard_summary — one row of counts for GET /ui/dashboard/summary.
-- Company scope: p_company_id null => whole org; else that company only.
-- Revenue: sum ui_value_cents over booking activity events in the UTC day / week,
-- matching summarizeRevenueFromEvents().
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ui_dashboard_summary(
  p_org_id uuid,
  p_company_id uuid default null
)
returns table (
  active_workflow_count integer,
  failed_workflow_job_count integer,
  new_lead_count integer,
  overdue_task_count integer,
  revenue_today_cents numeric,
  revenue_week_cents numeric,
  today_booking_count integer,
  upcoming_booking_count integer,
  urgent_task_count integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with
  now_utc as (select timezone('utc', now()) as ts),
  day_start as (select date_trunc('day', (select ts from now_utc)) as ts),
  day_end as (select (select ts from day_start) + interval '1 day' - interval '1 millisecond' as ts),
  week_start as (select date_trunc('week', (select ts from now_utc)) as ts)
  select
    (select count(*)::integer from public.workflows w
       where w.organization_id = p_org_id and w.status = 'active'
         and (p_company_id is null or w.company_id = p_company_id)),
    (select count(*)::integer from public.workflow_event_jobs j
       where j.organization_id = p_org_id and j.status = 'failed'
         and (p_company_id is null or j.company_id = p_company_id)),
    (select count(*)::integer from public.contacts c
       where c.organization_id = p_org_id and c.stage = 'lead'
         and (p_company_id is null or c.company_id = p_company_id)),
    (select count(*)::integer from public.tasks t
       where t.organization_id = p_org_id and t.status <> 'completed'
         and t.due_at is not null and t.due_at < (select ts from now_utc)
         and (p_company_id is null or t.company_id = p_company_id)),
    coalesce((select sum(public.ui_value_cents(e.metadata_json)) from public.activity_events e
       where e.organization_id = p_org_id and e.entity_type = 'booking'
         and e.occurred_at >= (select ts from day_start) and e.occurred_at <= (select ts from day_end)
         and (p_company_id is null or e.company_id = p_company_id)), 0),
    coalesce((select sum(public.ui_value_cents(e.metadata_json)) from public.activity_events e
       where e.organization_id = p_org_id and e.entity_type = 'booking'
         and e.occurred_at >= (select ts from week_start)
         and (p_company_id is null or e.company_id = p_company_id)), 0),
    (select count(*)::integer from public.bookings b
       where b.organization_id = p_org_id
         and b.scheduled_for >= (select ts from day_start) and b.scheduled_for <= (select ts from day_end)
         and (p_company_id is null or b.company_id = p_company_id)),
    (select count(*)::integer from public.bookings b
       where b.organization_id = p_org_id and b.scheduled_for > (select ts from now_utc)
         and (p_company_id is null or b.company_id = p_company_id)),
    (select count(*)::integer from public.tasks t
       where t.organization_id = p_org_id and t.priority = 'urgent' and t.status <> 'completed'
         and (p_company_id is null or t.company_id = p_company_id));
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ui_automation_impact — GET /ui/dashboard/automation-impact.
-- since_ts is accepted for parity with the endpoint but the current shape counts
-- all-time (getAutomationImpact does not filter by time); pass null.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ui_automation_impact(
  p_org_id uuid,
  p_company_id uuid default null,
  p_since_ts timestamptz default null
)
returns table (
  estimated_time_saved_seconds bigint,
  failed_jobs_count integer,
  successful_runs integer,
  tasks_auto_created bigint,
  total_workflow_runs integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce((select sum(r.time_saved_seconds) from public.workflow_runs r
       where r.organization_id = p_org_id
         and (p_company_id is null or r.company_id = p_company_id)
         and (p_since_ts is null or r.created_at >= p_since_ts)), 0),
    (select count(*)::integer from public.workflow_event_jobs j
       where j.organization_id = p_org_id and j.status = 'failed'
         and (p_company_id is null or j.company_id = p_company_id)),
    (select count(*)::integer from public.workflow_runs r
       where r.organization_id = p_org_id and r.status = 'completed'
         and (p_company_id is null or r.company_id = p_company_id)
         and (p_since_ts is null or r.created_at >= p_since_ts)),
    coalesce((select sum(r.created_tasks_count) from public.workflow_runs r
       where r.organization_id = p_org_id
         and (p_company_id is null or r.company_id = p_company_id)
         and (p_since_ts is null or r.created_at >= p_since_ts)), 0),
    (select count(*)::integer from public.workflow_runs r
       where r.organization_id = p_org_id
         and (p_company_id is null or r.company_id = p_company_id)
         and (p_since_ts is null or r.created_at >= p_since_ts));
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ui_activity_feed — GET /ui/dashboard/activity, keyset-paginated by occurred_at.
-- Returns the raw event columns the feed maps (company/entity resolution stays in
-- TS via the small companies/entity lookups). p_before_ts is the keyset cursor
-- (rows strictly older than it); null starts at the newest.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ui_activity_feed(
  p_org_id uuid,
  p_company_id uuid default null,
  p_limit integer default 25,
  p_before_ts timestamptz default null
)
returns setof public.activity_events
language sql
stable
security invoker
set search_path = public
as $$
  select e.*
  from public.activity_events e
  where e.organization_id = p_org_id
    and (p_company_id is null or e.company_id = p_company_id)
    and (p_before_ts is null or e.occurred_at < p_before_ts)
  order by e.occurred_at desc
  limit greatest(p_limit, 1);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ui_calendar_bookings — bookings in a time window with their linked-task rollups
-- (count, highest priority, assigned profile ids) + contact/company fields +
-- revenue. The TS maps assignedUserSummary/assignedUsers from the profile ids.
-- Revenue mirrors buildBookingRevenueMap: contact.metadata value if positive, else
-- the newest booking activity-event value.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ui_calendar_bookings(
  p_org_id uuid,
  p_company_id uuid default null,
  p_from_ts timestamptz default null,
  p_to_ts timestamptz default null
)
returns table (
  id uuid,
  scheduled_for timestamptz,
  duration_minutes integer,
  status text,
  title text,
  description text,
  company_id uuid,
  company_name text,
  company_stage text,
  contact_id uuid,
  contact_name text,
  contact_email text,
  contact_phone text,
  contact_stage text,
  contact_company_id uuid,
  contact_company_name text,
  contact_company_stage text,
  task_count integer,
  highest_priority text,
  assigned_profile_ids uuid[],
  revenue_cents numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    b.id,
    b.scheduled_for,
    b.duration_minutes,
    b.status::text,
    b.title,
    b.description,
    b.company_id,
    co.name,
    co.stage::text,
    b.contact_id,
    nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''),
    ct.email,
    ct.phone,
    ct.stage::text,
    ct.company_id,
    cco.name,
    cco.stage::text,
    coalesce(tk.task_count, 0)::integer,
    tk.highest_priority,
    coalesce(tk.assigned_profile_ids, array[]::uuid[]),
    coalesce(
      nullif(public.ui_value_cents(ct.metadata), 0),
      (select public.ui_value_cents(e.metadata_json)
         from public.activity_events e
        where e.organization_id = p_org_id and e.entity_type = 'booking' and e.entity_id = b.id
          and public.ui_value_cents(e.metadata_json) is not null
        order by e.occurred_at desc limit 1),
      public.ui_value_cents(ct.metadata)
    )
  from public.bookings b
  left join public.companies co on co.id = b.company_id and co.organization_id = b.organization_id
  left join public.contacts ct on ct.id = b.contact_id and ct.organization_id = b.organization_id
  left join public.companies cco on cco.id = ct.company_id and cco.organization_id = b.organization_id
  left join lateral (
    select
      count(*)::integer as task_count,
      (array_agg(t.priority::text order by
        case t.priority when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 else 1 end desc))[1] as highest_priority,
      array_remove(array_agg(distinct t.assigned_to_profile_id), null) as assigned_profile_ids
    from public.tasks t
    where t.booking_id = b.id and t.organization_id = b.organization_id
  ) tk on true
  where b.organization_id = p_org_id
    and (p_company_id is null or b.company_id = p_company_id)
    and (p_from_ts is null or b.scheduled_for >= p_from_ts)
    and (p_to_ts is null or b.scheduled_for <= p_to_ts)
  order by b.scheduled_for asc;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ui_task_list_v — one row per task with assignee/contact/company/booking/workflow
-- fields, comment count, and overdue flag. Filtering/search/pagination happen in
-- the query that selects from it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.ui_task_list_v
with (security_invoker = true)
as
  select
    t.id,
    t.organization_id,
    t.company_id,
    t.contact_id,
    t.booking_id,
    t.workflow_id,
    t.assigned_to_profile_id,
    t.title,
    t.description,
    t.status::text as status,
    t.priority::text as priority,
    t.due_at,
    t.created_at,
    (t.due_at is not null and t.status <> 'completed' and t.due_at < timezone('utc', now())) as is_overdue,
    lower(coalesce(t.id::text, '') || ' ' || coalesce(t.title, '') || ' ' || coalesce(t.description, '')) as search_text,
    co.name as company_name,
    co.stage::text as company_stage,
    asg.id as assignee_id,
    asg.full_name as assignee_full_name,
    asg.email as assignee_email,
    ct.first_name as contact_first_name,
    ct.last_name as contact_last_name,
    ct.email as contact_email,
    ct.phone as contact_phone,
    ct.stage::text as contact_stage,
    ct.company_id as contact_company_id,
    cco.name as contact_company_name,
    cco.stage::text as contact_company_stage,
    bk.title as booking_title,
    wf.name as workflow_name,
    (select count(*)::integer from public.comments cm
       where cm.entity_type = 'task' and cm.entity_id = t.id and cm.organization_id = t.organization_id) as comments_count
  from public.tasks t
  left join public.companies co on co.id = t.company_id and co.organization_id = t.organization_id
  left join public.profiles asg on asg.id = t.assigned_to_profile_id
  left join public.contacts ct on ct.id = t.contact_id and ct.organization_id = t.organization_id
  left join public.companies cco on cco.id = ct.company_id and cco.organization_id = t.organization_id
  left join public.bookings bk on bk.id = t.booking_id and bk.organization_id = t.organization_id
  left join public.workflows wf on wf.id = t.workflow_id and wf.organization_id = t.organization_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- ui_workflow_list_v — one row per workflow with run rollups (total/successful/
-- failed/success rate, last run, recent-7d count).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.ui_workflow_list_v
with (security_invoker = true)
as
  select
    w.id,
    w.organization_id,
    w.company_id,
    w.name,
    w.description,
    w.status::text as status,
    w.trigger_event as trigger_type,
    w.created_at,
    co.name as company_name,
    co.stage::text as company_stage,
    coalesce(r.total_runs, 0)::integer as total_runs,
    coalesce(r.successful_runs, 0)::integer as successful_runs,
    coalesce(r.failed_runs, 0)::integer as failed_runs,
    r.last_run_at,
    r.last_run_status,
    coalesce(r.recent_runs_count, 0)::integer as recent_runs_count
  from public.workflows w
  left join public.companies co on co.id = w.company_id and co.organization_id = w.organization_id
  left join lateral (
    select
      count(*)::integer as total_runs,
      count(*) filter (where rn.status = 'completed')::integer as successful_runs,
      count(*) filter (where rn.status = 'failed')::integer as failed_runs,
      max(rn.created_at) as last_run_at,
      (array_agg(rn.status::text order by rn.created_at desc))[1] as last_run_status,
      count(*) filter (where rn.created_at >= timezone('utc', now()) - interval '7 days')::integer as recent_runs_count
    from public.workflow_runs rn
    where rn.workflow_id = w.id and rn.organization_id = w.organization_id
  ) r on true;

-- ─────────────────────────────────────────────────────────────────────────────
-- ui_workflow_jobs_v — one row per workflow_event_job with its activity-event type
-- and company fields (for the automations/jobs list).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.ui_workflow_jobs_v
with (security_invoker = true)
as
  select
    j.id,
    j.organization_id,
    j.company_id,
    j.activity_event_id,
    j.status::text as status,
    j.attempt_count,
    j.available_at,
    j.locked_at,
    j.completed_at,
    j.last_attempted_at,
    j.last_error,
    j.created_at,
    co.name as company_name,
    co.stage::text as company_stage,
    ae.event_type as activity_event_type
  from public.workflow_event_jobs j
  left join public.companies co on co.id = j.company_id and co.organization_id = j.organization_id
  left join public.activity_events ae on ae.id = j.activity_event_id and ae.organization_id = j.organization_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- ui_contact_list_v — one row per contact with company/owner fields, last activity,
-- booking rollups, realized/pipeline revenue, and the computed next action. This is
-- the read model that replaces the whole-table in-memory join in getCRMContactsView.
--
-- next_action mirrors getNextActionForContact's branch order: overdue task ->
-- pending future booking -> open task -> closed -> default. Tie-breaks: newest
-- overdue/open task (created_at desc, matching the JS list order), earliest pending
-- booking. Revenue mirrors buildBookingRevenueMap (positive contact.metadata value,
-- else the newest booking activity-event value).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.ui_contact_list_v
with (security_invoker = true)
as
  select
    c.id,
    c.organization_id,
    c.company_id,
    c.owner_profile_id,
    nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') as name,
    c.email,
    c.phone,
    c.stage::text as stage,
    c.search_text,
    co.name as company_name,
    co.stage::text as company_stage,
    ow.id as owner_id,
    ow.full_name as owner_full_name,
    ow.email as owner_email,
    public.ui_value_cents(c.metadata) as pipeline_value_cents,
    la.last_activity_at,
    la.last_activity_event_type,
    coalesce(bk.bookings_count, 0) as bookings_count,
    coalesce(bk.upcoming_bookings_count, 0) as upcoming_bookings_count,
    coalesce(bk.realized_revenue_cents, 0) as realized_revenue_cents,
    na.next_action_type,
    na.next_action_label,
    na.next_action_detail,
    na.next_action_due_at
  from public.contacts c
  left join public.companies co on co.id = c.company_id and co.organization_id = c.organization_id
  left join public.profiles ow on ow.id = c.owner_profile_id
  left join lateral (
    select e.event_type as last_activity_event_type, e.occurred_at as last_activity_at
    from public.activity_events e
    where e.organization_id = c.organization_id
      and ((e.entity_type = 'contact' and e.entity_id = c.id)
        or (e.related_entity_type = 'contact' and e.related_entity_id = c.id))
    order by e.occurred_at desc
    limit 1
  ) la on true
  left join lateral (
    select
      count(*)::integer as bookings_count,
      count(*) filter (
        where b.scheduled_for > timezone('utc', now()) and b.status <> 'completed'
      )::integer as upcoming_bookings_count,
      coalesce(sum(coalesce(
        nullif(public.ui_value_cents(c.metadata), 0),
        (select public.ui_value_cents(e.metadata_json)
           from public.activity_events e
          where e.organization_id = c.organization_id and e.entity_type = 'booking' and e.entity_id = b.id
            and public.ui_value_cents(e.metadata_json) is not null
          order by e.occurred_at desc limit 1),
        0
      )), 0) as realized_revenue_cents
    from public.bookings b
    where b.contact_id = c.id and b.organization_id = c.organization_id
  ) bk on true
  left join lateral (
    with
    ot as (
      select title, due_at from public.tasks t
      where t.contact_id = c.id and t.organization_id = c.organization_id
        and t.status <> 'completed' and t.due_at is not null and t.due_at < timezone('utc', now())
      order by t.created_at desc limit 1
    ),
    pb as (
      select title, scheduled_for, status from public.bookings b
      where b.contact_id = c.id and b.organization_id = c.organization_id
        and b.status <> 'completed' and b.scheduled_for > timezone('utc', now())
      order by b.scheduled_for asc limit 1
    ),
    op as (
      select title, due_at from public.tasks t
      where t.contact_id = c.id and t.organization_id = c.organization_id and t.status <> 'completed'
      order by t.created_at desc limit 1
    )
    select
      case
        when exists (select 1 from ot) then 'urgent'
        when exists (select 1 from pb) then case when (select status from pb) = 'pending' then 'urgent' else 'wait' end
        when exists (select 1 from op) then 'action'
        when c.stage = 'closed' then 'done'
        else 'action'
      end as next_action_type,
      case
        when exists (select 1 from ot) then 'Resolve overdue task'
        when exists (select 1 from pb) then case when (select status from pb) = 'pending' then 'Confirm booking' else 'Prepare upcoming booking' end
        when exists (select 1 from op) then 'Advance open task'
        when c.stage = 'closed' then 'Closed'
        when c.stage = 'lead' then 'Qualify lead'
        else 'Schedule follow-up'
      end as next_action_label,
      case
        when exists (select 1 from ot) then (select title from ot)
        when exists (select 1 from pb) then (select title from pb)
        when exists (select 1 from op) then (select title from op)
        when c.stage = 'closed' then 'Contact is closed.'
        else 'No linked work yet.'
      end as next_action_detail,
      case
        when exists (select 1 from ot) then (select due_at from ot)
        when exists (select 1 from pb) then (select scheduled_for from pb)
        when exists (select 1 from op) then (select due_at from op)
        else null
      end as next_action_due_at
  ) na on true;

-- ─────────────────────────────────────────────────────────────────────────────
-- Detail RPCs — a single row per entity plus its directly-linked children as jsonb
-- arrays, so a detail screen no longer loads whole tables to find one row. Each
-- returns one `data jsonb`; the live-data.ts detail functions read it and still
-- compose the trace/comments/quotes (already targeted queries) on top.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ui_contact_detail(p_org_id uuid, p_contact_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'contact', to_jsonb(c),
    'company', to_jsonb(co),
    'owner', to_jsonb(ow),
    'bookings', (
      select coalesce(jsonb_agg(to_jsonb(b) order by b.scheduled_for), '[]'::jsonb)
      from public.bookings b where b.contact_id = c.id and b.organization_id = p_org_id
    ),
    'tasks', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
      from public.tasks t where t.contact_id = c.id and t.organization_id = p_org_id
    )
  )
  from public.contacts c
  left join public.companies co on co.id = c.company_id and co.organization_id = c.organization_id
  left join public.profiles ow on ow.id = c.owner_profile_id
  where c.id = p_contact_id and c.organization_id = p_org_id;
$$;

create or replace function public.ui_task_detail(p_org_id uuid, p_task_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'task', to_jsonb(t),
    'company', to_jsonb(co),
    'assignee', to_jsonb(asg),
    'contact', to_jsonb(ct),
    'contact_company', to_jsonb(cco),
    'booking', to_jsonb(bk),
    'workflow', to_jsonb(wf)
  )
  from public.tasks t
  left join public.companies co on co.id = t.company_id and co.organization_id = t.organization_id
  left join public.profiles asg on asg.id = t.assigned_to_profile_id
  left join public.contacts ct on ct.id = t.contact_id and ct.organization_id = t.organization_id
  left join public.companies cco on cco.id = ct.company_id and cco.organization_id = t.organization_id
  left join public.bookings bk on bk.id = t.booking_id and bk.organization_id = t.organization_id
  left join public.workflows wf on wf.id = t.workflow_id and wf.organization_id = t.organization_id
  where t.id = p_task_id and t.organization_id = p_org_id;
$$;

create or replace function public.ui_workflow_detail(p_org_id uuid, p_workflow_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'workflow', to_jsonb(w),
    'company', to_jsonb(co),
    'runs', (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
      from public.workflow_runs r where r.workflow_id = w.id and r.organization_id = p_org_id
    ),
    'failed_jobs', (
      select coalesce(jsonb_agg(to_jsonb(j) order by coalesce(j.completed_at, j.updated_at) desc), '[]'::jsonb)
      from public.workflow_event_jobs j
      where j.organization_id = p_org_id and j.status = 'failed'
        and exists (
          select 1 from public.workflow_runs r
          where r.workflow_id = w.id and r.organization_id = p_org_id and r.trigger_event_id = j.activity_event_id
        )
    )
  )
  from public.workflows w
  left join public.companies co on co.id = w.company_id and co.organization_id = w.organization_id
  where w.id = p_workflow_id and w.organization_id = p_org_id;
$$;
