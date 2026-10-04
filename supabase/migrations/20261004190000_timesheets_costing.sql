-- Timesheets & job costing.
--   * time_entries — clock in/out per person, optionally against a job (booking)
--   * job_materials — materials / expenses used on a job
--   * member_pay_rates — what an hour of each person costs (owners/admins only)
--   * close_job_time_entries(booking) — "job done" stops everyone's running clock on it
-- Rollback: supabase/rollback/20261004190000_timesheets_costing.down.sql

-- ── 1) time_entries ───────────────────────────────────────────────────────────
create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  booking_id uuid references public.bookings (id) on delete set null,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  break_minutes integer not null default 0 check (break_minutes between 0 and 600),
  notes text check (notes is null or char_length(notes) <= 1000),
  source text not null default 'clock' check (source in ('clock', 'manual')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (ended_at is null or ended_at > started_at),
  check (ended_at is null or ended_at - started_at <= interval '24 hours')
);

-- One running clock per person per organization.
create unique index if not exists time_entries_one_running
  on public.time_entries (organization_id, profile_id) where ended_at is null;
create index if not exists time_entries_org_started_idx on public.time_entries (organization_id, started_at desc);
create index if not exists time_entries_booking_idx on public.time_entries (booking_id);

drop trigger if exists time_entries_set_updated_at on public.time_entries;
create trigger time_entries_set_updated_at
before update on public.time_entries
for each row execute procedure public.touch_updated_at();

alter table public.time_entries enable row level security;

drop policy if exists "time_entries_select" on public.time_entries;
drop policy if exists "time_entries_insert" on public.time_entries;
drop policy if exists "time_entries_update" on public.time_entries;
drop policy if exists "time_entries_delete" on public.time_entries;
-- Your own hours; owners/admins see everyone's.
create policy "time_entries_select"
  on public.time_entries for select
  using (
    public.is_organization_member(organization_id)
    and (profile_id = auth.uid() or public.is_organization_admin(organization_id))
  );
create policy "time_entries_insert"
  on public.time_entries for insert
  with check (
    public.is_organization_member(organization_id)
    and (profile_id = auth.uid() or public.is_organization_admin(organization_id))
    and exists (select 1 from public.organization_memberships m where m.organization_id = time_entries.organization_id and m.profile_id = time_entries.profile_id)
    and (booking_id is null or exists (select 1 from public.bookings b where b.id = booking_id and b.organization_id = time_entries.organization_id))
  );
create policy "time_entries_update"
  on public.time_entries for update
  using (
    public.is_organization_member(organization_id)
    and (profile_id = auth.uid() or public.is_organization_admin(organization_id))
  )
  with check (
    public.is_organization_member(organization_id)
    and (profile_id = auth.uid() or public.is_organization_admin(organization_id))
    and (booking_id is null or exists (select 1 from public.bookings b where b.id = booking_id and b.organization_id = time_entries.organization_id))
  );
create policy "time_entries_delete"
  on public.time_entries for delete
  using (
    public.is_organization_member(organization_id)
    and (profile_id = auth.uid() or public.is_organization_admin(organization_id))
  );

-- ── 2) job_materials ──────────────────────────────────────────────────────────
create table if not exists public.job_materials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 200),
  quantity numeric(12, 2) not null default 1 check (quantity > 0),
  unit_cost_cents integer not null check (unit_cost_cents between 0 and 100000000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists job_materials_booking_idx on public.job_materials (booking_id);

alter table public.job_materials enable row level security;

drop policy if exists "job_materials_members_select" on public.job_materials;
drop policy if exists "job_materials_members_insert" on public.job_materials;
drop policy if exists "job_materials_own_or_admin_delete" on public.job_materials;
create policy "job_materials_members_select"
  on public.job_materials for select
  using (public.is_organization_member(organization_id));
create policy "job_materials_members_insert"
  on public.job_materials for insert
  with check (
    public.is_organization_member(organization_id)
    and exists (select 1 from public.bookings b where b.id = booking_id and b.organization_id = job_materials.organization_id)
  );
create policy "job_materials_own_or_admin_delete"
  on public.job_materials for delete
  using (
    public.is_organization_member(organization_id)
    and (created_by = auth.uid() or public.is_organization_admin(organization_id))
  );

-- ── 3) member_pay_rates (owners/admins only — crew don't see each other's rates) ──
create table if not exists public.member_pay_rates (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  hourly_cost_cents integer not null check (hourly_cost_cents between 0 and 100000),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, profile_id)
);

alter table public.member_pay_rates enable row level security;

drop policy if exists "member_pay_rates_admins_all" on public.member_pay_rates;
create policy "member_pay_rates_admins_all"
  on public.member_pay_rates for all
  using (public.is_organization_admin(organization_id))
  with check (
    public.is_organization_admin(organization_id)
    and exists (select 1 from public.organization_memberships m where m.organization_id = member_pay_rates.organization_id and m.profile_id = member_pay_rates.profile_id)
  );

-- ── 4) Job done → stop every running clock on that job ────────────────────────
-- Security definer because a crew member may only update their OWN entries, but
-- finishing the job should stop the whole crew's clocks. Scoped to the caller's org.
create or replace function public.close_job_time_entries(p_booking_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_count integer;
begin
  select organization_id into v_org from public.bookings where id = p_booking_id;
  if v_org is null or not public.is_organization_member(v_org) then
    return 0;
  end if;
  update public.time_entries
     set ended_at = greatest(now(), started_at + interval '1 minute')
   where booking_id = p_booking_id
     and organization_id = v_org
     and ended_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.close_job_time_entries(uuid) from public;
grant execute on function public.close_job_time_entries(uuid) to authenticated, service_role;

grant select, insert, update, delete on public.time_entries, public.job_materials, public.member_pay_rates to authenticated, service_role;
