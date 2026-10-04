-- Crew & job dispatch.
--   * booking_assignments — who is on the job (any number of crew per booking)
--   * booking_checklist_items — the job's checklist, ticked off in the field
--   * checklist_templates — reusable checklists per brand ("Shrink wrap", "Winterize")
--   * bookings.location / en_route_at / started_at / completed_at / completed_by
--   * ui_calendar_bookings: the crew now includes direct assignments
-- Rollback: supabase/rollback/20261004170000_crew_dispatch.down.sql

-- ── 1) Booking field-work columns ─────────────────────────────────────────────
alter table public.bookings add column if not exists location text;
alter table public.bookings add column if not exists en_route_at timestamptz;
alter table public.bookings add column if not exists started_at timestamptz;
alter table public.bookings add column if not exists completed_at timestamptz;
alter table public.bookings add column if not exists completed_by uuid references public.profiles (id) on delete set null;

-- ── 2) booking_assignments ────────────────────────────────────────────────────
create table if not exists public.booking_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  assigned_by uuid references public.profiles (id) on delete set null,
  notified_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (booking_id, profile_id)
);

create index if not exists booking_assignments_profile_idx
  on public.booking_assignments (organization_id, profile_id);

alter table public.booking_assignments enable row level security;

drop policy if exists "booking_assignments_members_select" on public.booking_assignments;
drop policy if exists "booking_assignments_members_insert" on public.booking_assignments;
drop policy if exists "booking_assignments_members_update" on public.booking_assignments;
drop policy if exists "booking_assignments_members_delete" on public.booking_assignments;

create policy "booking_assignments_members_select"
  on public.booking_assignments for select
  using (public.is_organization_member(organization_id));
-- Only a member of the same organization can be put on a job, and only on that org's booking.
create policy "booking_assignments_members_insert"
  on public.booking_assignments for insert
  with check (
    public.is_organization_member(organization_id)
    and exists (select 1 from public.bookings b where b.id = booking_id and b.organization_id = booking_assignments.organization_id)
    and exists (
      select 1 from public.organization_memberships m
      where m.organization_id = booking_assignments.organization_id and m.profile_id = booking_assignments.profile_id
    )
  );
create policy "booking_assignments_members_update"
  on public.booking_assignments for update
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "booking_assignments_members_delete"
  on public.booking_assignments for delete
  using (public.is_organization_member(organization_id));

-- ── 3) booking_checklist_items ────────────────────────────────────────────────
create table if not exists public.booking_checklist_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 200),
  position integer not null default 0,
  done_at timestamptz,
  done_by uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists booking_checklist_items_booking_idx
  on public.booking_checklist_items (booking_id, position);

alter table public.booking_checklist_items enable row level security;

drop policy if exists "booking_checklist_members_all" on public.booking_checklist_items;
create policy "booking_checklist_members_all"
  on public.booking_checklist_items for all
  using (public.is_organization_member(organization_id))
  with check (
    public.is_organization_member(organization_id)
    and exists (select 1 from public.bookings b where b.id = booking_id and b.organization_id = booking_checklist_items.organization_id)
  );

-- ── 4) checklist_templates ────────────────────────────────────────────────────
create table if not exists public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists checklist_templates_company_idx
  on public.checklist_templates (organization_id, company_id, name);

drop trigger if exists checklist_templates_set_updated_at on public.checklist_templates;
create trigger checklist_templates_set_updated_at
before update on public.checklist_templates
for each row execute procedure public.touch_updated_at();

alter table public.checklist_templates enable row level security;

drop policy if exists "checklist_templates_members_select" on public.checklist_templates;
drop policy if exists "checklist_templates_admins_write" on public.checklist_templates;
create policy "checklist_templates_members_select"
  on public.checklist_templates for select
  using (public.is_organization_member(organization_id));
create policy "checklist_templates_admins_write"
  on public.checklist_templates for all
  using (public.is_organization_admin(organization_id))
  with check (
    public.is_organization_admin(organization_id)
    and exists (select 1 from public.companies c where c.id = company_id and c.organization_id = checklist_templates.organization_id)
  );

-- ── 5) Calendar read model: crew includes direct assignments ──────────────────
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
    -- The crew: people assigned to the job directly, then anyone assigned one of its tasks.
    coalesce(
      (select array_agg(distinct p) from unnest(coalesce(crew.profile_ids, array[]::uuid[]) || coalesce(tk.assigned_profile_ids, array[]::uuid[])) p),
      array[]::uuid[]
    ),
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
  left join lateral (
    select array_agg(a.profile_id order by a.created_at) as profile_ids
    from public.booking_assignments a
    where a.booking_id = b.id and a.organization_id = b.organization_id
  ) crew on true
  where b.organization_id = p_org_id
    and (p_company_id is null or b.company_id = p_company_id)
    and (p_from_ts is null or b.scheduled_for >= p_from_ts)
    and (p_to_ts is null or b.scheduled_for <= p_to_ts)
  order by b.scheduled_for asc;
$$;
