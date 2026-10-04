-- Rollback for 20261004170000_crew_dispatch.sql. Destroys crew assignments, checklists and templates.
-- First restore the previous ui_calendar_bookings (tasks-only crew).
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

drop table if exists public.checklist_templates;
drop table if exists public.booking_checklist_items;
drop table if exists public.booking_assignments;
alter table public.bookings drop column if exists completed_by;
alter table public.bookings drop column if exists completed_at;
alter table public.bookings drop column if exists started_at;
alter table public.bookings drop column if exists en_route_at;
alter table public.bookings drop column if exists location;
