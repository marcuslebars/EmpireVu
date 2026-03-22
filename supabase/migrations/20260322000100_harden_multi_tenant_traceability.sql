create type public.contact_stage_v2 as enum ('lead', 'qualified', 'active', 'closed');
create type public.booking_status_v2 as enum ('pending', 'confirmed', 'completed', 'cancelled');
create type public.task_status_v2 as enum ('todo', 'in_progress', 'blocked', 'completed');
create type public.workflow_run_status_v2 as enum ('pending', 'running', 'completed', 'failed');

alter table public.contacts
  alter column stage drop default;

alter table public.contacts
  alter column stage type public.contact_stage_v2
  using (
    case stage::text
      when 'customer' then 'active'
      when 'inactive' then 'closed'
      when 'archived' then 'closed'
      else stage::text
    end
  )::public.contact_stage_v2;

drop type public.contact_stage;
alter type public.contact_stage_v2 rename to contact_stage;

alter table public.contacts
  alter column stage set default 'lead';

alter table public.bookings
  alter column status drop default;

alter table public.bookings
  alter column status type public.booking_status_v2
  using (
    case status::text
      when 'no_show' then 'cancelled'
      else status::text
    end
  )::public.booking_status_v2;

drop type public.booking_status;
alter type public.booking_status_v2 rename to booking_status;

alter table public.bookings
  alter column status set default 'pending';

alter table public.tasks
  alter column status drop default;

alter table public.tasks
  alter column status type public.task_status_v2
  using (
    case status::text
      when 'cancelled' then 'blocked'
      else status::text
    end
  )::public.task_status_v2;

drop type public.task_status;
alter type public.task_status_v2 rename to task_status;

alter table public.tasks
  alter column status set default 'todo';

alter table public.workflow_runs
  alter column status drop default;

alter table public.workflow_runs
  alter column status type public.workflow_run_status_v2
  using (
    case status::text
      when 'queued' then 'pending'
      when 'succeeded' then 'completed'
      when 'cancelled' then 'failed'
      else status::text
    end
  )::public.workflow_run_status_v2;

drop type public.workflow_run_status;
alter type public.workflow_run_status_v2 rename to workflow_run_status;

alter table public.workflow_runs
  alter column status set default 'pending';

alter table public.activity_events
  add column actor_user_id uuid references auth.users (id) on delete set null,
  add column entity_type text,
  add column entity_id uuid,
  add column related_entity_type text,
  add column related_entity_id uuid,
  add column metadata_json jsonb not null default '{}'::jsonb;

update public.activity_events
set
  actor_user_id = actor_profile_id,
  entity_type = subject_type,
  entity_id = subject_id,
  metadata_json = metadata;

alter table public.activity_events
  alter column entity_type set not null;

alter table public.activity_events
  drop column actor_profile_id,
  drop column subject_type,
  drop column subject_id,
  drop column metadata;

alter table public.workflow_runs
  rename column payload to context_json;

alter table public.workflow_runs
  rename column error_message to failure_reason;

alter table public.workflow_runs
  add column logs_json jsonb not null default '[]'::jsonb,
  add column actions_executed_count integer not null default 0 check (actions_executed_count >= 0),
  add column created_tasks_count integer not null default 0 check (created_tasks_count >= 0),
  add column time_saved_seconds integer not null default 0 check (time_saved_seconds >= 0);

update public.bookings booking
set company_id = contact.company_id
from public.contacts contact
where booking.organization_id = contact.organization_id
  and booking.contact_id = contact.id
  and booking.company_id is null;

alter table public.contacts
  alter column company_id set not null;

alter table public.bookings
  alter column company_id set not null;

alter table public.workflow_runs
  add constraint workflow_runs_completed_after_started_chk
  check (completed_at is null or started_at is null or completed_at >= started_at);

create or replace function public.resolve_trace_entity(
  p_organization_id uuid,
  p_entity_type text,
  p_entity_id uuid
)
returns table (entity_exists boolean, company_id uuid)
language plpgsql
stable
as $$
begin
  case p_entity_type
    when 'company' then
      return query
      select true, company.id
      from public.companies company
      where company.organization_id = p_organization_id
        and company.id = p_entity_id;
    when 'contact' then
      return query
      select true, contact.company_id
      from public.contacts contact
      where contact.organization_id = p_organization_id
        and contact.id = p_entity_id;
    when 'booking' then
      return query
      select true, booking.company_id
      from public.bookings booking
      where booking.organization_id = p_organization_id
        and booking.id = p_entity_id;
    when 'task' then
      return query
      select true, task.company_id
      from public.tasks task
      where task.organization_id = p_organization_id
        and task.id = p_entity_id;
    when 'workflow' then
      return query
      select true, workflow.company_id
      from public.workflows workflow
      where workflow.organization_id = p_organization_id
        and workflow.id = p_entity_id;
    when 'workflow_run' then
      return query
      select true, workflow_run.company_id
      from public.workflow_runs workflow_run
      where workflow_run.organization_id = p_organization_id
        and workflow_run.id = p_entity_id;
    when 'activity_event' then
      return query
      select true, activity_event.company_id
      from public.activity_events activity_event
      where activity_event.organization_id = p_organization_id
        and activity_event.id = p_entity_id;
    else
      return query select false, null::uuid;
      return;
  end case;

  if not found then
    return query select false, null::uuid;
  end if;
end;
$$;

create or replace function public.set_booking_company_scope()
returns trigger
language plpgsql
as $$
declare
  contact_company_id uuid;
begin
  if new.contact_id is not null then
    select contact.company_id
    into contact_company_id
    from public.contacts contact
    where contact.organization_id = new.organization_id
      and contact.id = new.contact_id;

    new.company_id := coalesce(new.company_id, contact_company_id);

    if new.company_id is distinct from contact_company_id then
      raise exception 'Booking company_id must match the linked contact company.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.set_task_relationship_scope()
returns trigger
language plpgsql
as $$
declare
  contact_company_id uuid;
  booking_company_id uuid;
  booking_contact_id uuid;
  workflow_company_id uuid;
  resolved_company_id uuid;
begin
  if new.contact_id is not null then
    select contact.company_id
    into contact_company_id
    from public.contacts contact
    where contact.organization_id = new.organization_id
      and contact.id = new.contact_id;
  end if;

  if new.booking_id is not null then
    select booking.company_id, booking.contact_id
    into booking_company_id, booking_contact_id
    from public.bookings booking
    where booking.organization_id = new.organization_id
      and booking.id = new.booking_id;

    if booking_contact_id is not null then
      new.contact_id := coalesce(new.contact_id, booking_contact_id);

      if new.contact_id is distinct from booking_contact_id then
        raise exception 'Task contact_id must match the linked booking contact.';
      end if;
    end if;
  end if;

  if new.workflow_id is not null then
    select workflow.company_id
    into workflow_company_id
    from public.workflows workflow
    where workflow.organization_id = new.organization_id
      and workflow.id = new.workflow_id;
  end if;

  resolved_company_id := coalesce(new.company_id, contact_company_id, booking_company_id, workflow_company_id);
  new.company_id := resolved_company_id;

  if contact_company_id is not null and new.company_id is distinct from contact_company_id then
    raise exception 'Task company_id must match the linked contact company.';
  end if;

  if booking_company_id is not null and new.company_id is distinct from booking_company_id then
    raise exception 'Task company_id must match the linked booking company.';
  end if;

  if workflow_company_id is not null and new.company_id is distinct from workflow_company_id then
    raise exception 'Task company_id must match the linked workflow company.';
  end if;

  return new;
end;
$$;

create or replace function public.set_comment_company_scope()
returns trigger
language plpgsql
as $$
declare
  target_exists boolean;
  target_company_id uuid;
begin
  select resolved.entity_exists, resolved.company_id
  into target_exists, target_company_id
  from public.resolve_trace_entity(new.organization_id, new.entity_type::text, new.entity_id) resolved;

  if not target_exists then
    raise exception 'Comment target does not exist in this organization.';
  end if;

  new.company_id := coalesce(new.company_id, target_company_id);

  if target_company_id is not null and new.company_id is distinct from target_company_id then
    raise exception 'Comment company_id must match the target entity company.';
  end if;

  return new;
end;
$$;

create or replace function public.set_activity_event_scope()
returns trigger
language plpgsql
as $$
declare
  entity_exists boolean;
  entity_company_id uuid;
  related_exists boolean;
  related_company_id uuid;
begin
  if (new.related_entity_type is null) <> (new.related_entity_id is null) then
    raise exception 'related_entity_type and related_entity_id must be provided together.';
  end if;

  if new.entity_id is not null then
    select resolved.entity_exists, resolved.company_id
    into entity_exists, entity_company_id
    from public.resolve_trace_entity(new.organization_id, new.entity_type, new.entity_id) resolved;

    if not entity_exists then
      raise exception 'Activity event entity does not exist in this organization.';
    end if;
  end if;

  if new.related_entity_id is not null then
    select resolved.entity_exists, resolved.company_id
    into related_exists, related_company_id
    from public.resolve_trace_entity(new.organization_id, new.related_entity_type, new.related_entity_id) resolved;

    if not related_exists then
      raise exception 'Activity event related entity does not exist in this organization.';
    end if;
  end if;

  new.company_id := coalesce(new.company_id, entity_company_id, related_company_id);

  if entity_company_id is not null and new.company_id is distinct from entity_company_id then
    raise exception 'Activity event company_id must match the primary entity company.';
  end if;

  if related_company_id is not null and new.company_id is distinct from related_company_id then
    raise exception 'Activity event company_id must match the related entity company.';
  end if;

  return new;
end;
$$;

create or replace function public.set_workflow_run_company_scope()
returns trigger
language plpgsql
as $$
declare
  workflow_company_id uuid;
  trigger_company_id uuid;
begin
  select workflow.company_id
  into workflow_company_id
  from public.workflows workflow
  where workflow.organization_id = new.organization_id
    and workflow.id = new.workflow_id;

  if new.trigger_event_id is not null then
    select activity_event.company_id
    into trigger_company_id
    from public.activity_events activity_event
    where activity_event.organization_id = new.organization_id
      and activity_event.id = new.trigger_event_id;
  end if;

  new.company_id := coalesce(new.company_id, workflow_company_id, trigger_company_id);

  if workflow_company_id is not null and new.company_id is distinct from workflow_company_id then
    raise exception 'Workflow run company_id must match the linked workflow company.';
  end if;

  if trigger_company_id is not null and new.company_id is distinct from trigger_company_id then
    raise exception 'Workflow run company_id must match the trigger event company.';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_set_company_scope on public.bookings;
create trigger bookings_set_company_scope
before insert or update on public.bookings
for each row execute procedure public.set_booking_company_scope();

drop trigger if exists tasks_set_relationship_scope on public.tasks;
create trigger tasks_set_relationship_scope
before insert or update on public.tasks
for each row execute procedure public.set_task_relationship_scope();

drop trigger if exists comments_set_company_scope on public.comments;
create trigger comments_set_company_scope
before insert or update on public.comments
for each row execute procedure public.set_comment_company_scope();

drop trigger if exists activity_events_set_company_scope on public.activity_events;
create trigger activity_events_set_company_scope
before insert or update on public.activity_events
for each row execute procedure public.set_activity_event_scope();

drop trigger if exists workflow_runs_set_company_scope on public.workflow_runs;
create trigger workflow_runs_set_company_scope
before insert or update on public.workflow_runs
for each row execute procedure public.set_workflow_run_company_scope();

drop index if exists public.activity_events_org_subject_idx;

create index if not exists companies_org_idx
  on public.companies (organization_id);
create index if not exists company_memberships_org_idx
  on public.company_memberships (organization_id);
create index if not exists contacts_org_idx
  on public.contacts (organization_id);
create index if not exists bookings_org_idx
  on public.bookings (organization_id);
create index if not exists tasks_org_idx
  on public.tasks (organization_id);
create index if not exists workflows_org_idx
  on public.workflows (organization_id);
create index if not exists workflow_runs_org_idx
  on public.workflow_runs (organization_id);
create index if not exists activity_events_org_idx
  on public.activity_events (organization_id);
create index if not exists comments_org_idx
  on public.comments (organization_id);
create index if not exists activity_events_org_entity_idx
  on public.activity_events (organization_id, entity_type, entity_id, occurred_at desc);
create index if not exists activity_events_org_related_entity_idx
  on public.activity_events (organization_id, related_entity_type, related_entity_id, occurred_at desc);
create index if not exists activity_events_org_company_occurred_idx
  on public.activity_events (organization_id, company_id, occurred_at desc);
create index if not exists workflow_runs_org_trigger_event_idx
  on public.workflow_runs (organization_id, trigger_event_id, created_at desc);
create index if not exists workflow_runs_org_company_status_idx
  on public.workflow_runs (organization_id, company_id, status, created_at desc);
create index if not exists comments_org_company_created_idx
  on public.comments (organization_id, company_id, created_at desc);