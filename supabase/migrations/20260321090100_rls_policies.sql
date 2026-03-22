create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.profile_id = auth.uid()
  );
$$;

create or replace function public.is_organization_admin(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.profile_id = auth.uid()
      and membership.role in ('owner', 'admin')
  );
$$;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.companies enable row level security;
alter table public.company_memberships enable row level security;
alter table public.contacts enable row level security;
alter table public.bookings enable row level security;
alter table public.tasks enable row level security;
alter table public.workflows enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.activity_events enable row level security;
alter table public.comments enable row level security;

create policy "profiles_select_shared_organizations"
on public.profiles
for select
using (
  id = auth.uid()
  or exists (
    select 1
    from public.organization_memberships requester
    join public.organization_memberships target
      on target.organization_id = requester.organization_id
    where requester.profile_id = auth.uid()
      and target.profile_id = public.profiles.id
  )
);

create policy "profiles_insert_self"
on public.profiles
for insert
with check (id = auth.uid());

create policy "profiles_update_self"
on public.profiles
for update
using (id = auth.uid())
with check (id = auth.uid());

create policy "organizations_select_members"
on public.organizations
for select
using (public.is_organization_member(id));

create policy "organizations_insert_authenticated"
on public.organizations
for insert
with check (created_by = auth.uid());

create policy "organizations_update_admins"
on public.organizations
for update
using (public.is_organization_admin(id))
with check (public.is_organization_admin(id));

create policy "organization_memberships_select_members"
on public.organization_memberships
for select
using (public.is_organization_member(organization_id));

create policy "organization_memberships_insert_admins"
on public.organization_memberships
for insert
with check (
  public.is_organization_admin(organization_id)
  or (
    profile_id = auth.uid()
    and role = 'owner'
    and exists (
      select 1
      from public.organizations organization_row
      where organization_row.id = organization_id
        and organization_row.created_by = auth.uid()
    )
  )
);

create policy "organization_memberships_update_admins"
on public.organization_memberships
for update
using (public.is_organization_admin(organization_id))
with check (public.is_organization_admin(organization_id));

create policy "organization_memberships_delete_admins"
on public.organization_memberships
for delete
using (public.is_organization_admin(organization_id));

create policy "companies_org_members_select"
on public.companies
for select
using (public.is_organization_member(organization_id));

create policy "companies_org_members_insert"
on public.companies
for insert
with check (public.is_organization_member(organization_id));

create policy "companies_org_members_update"
on public.companies
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "companies_org_members_delete"
on public.companies
for delete
using (public.is_organization_member(organization_id));

create policy "company_memberships_org_members_select"
on public.company_memberships
for select
using (public.is_organization_member(organization_id));

create policy "company_memberships_org_members_insert"
on public.company_memberships
for insert
with check (public.is_organization_member(organization_id));

create policy "company_memberships_org_members_update"
on public.company_memberships
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "company_memberships_org_members_delete"
on public.company_memberships
for delete
using (public.is_organization_member(organization_id));

create policy "contacts_org_members_select"
on public.contacts
for select
using (public.is_organization_member(organization_id));

create policy "contacts_org_members_insert"
on public.contacts
for insert
with check (public.is_organization_member(organization_id));

create policy "contacts_org_members_update"
on public.contacts
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "contacts_org_members_delete"
on public.contacts
for delete
using (public.is_organization_member(organization_id));

create policy "bookings_org_members_select"
on public.bookings
for select
using (public.is_organization_member(organization_id));

create policy "bookings_org_members_insert"
on public.bookings
for insert
with check (public.is_organization_member(organization_id));

create policy "bookings_org_members_update"
on public.bookings
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "bookings_org_members_delete"
on public.bookings
for delete
using (public.is_organization_member(organization_id));

create policy "tasks_org_members_select"
on public.tasks
for select
using (public.is_organization_member(organization_id));

create policy "tasks_org_members_insert"
on public.tasks
for insert
with check (public.is_organization_member(organization_id));

create policy "tasks_org_members_update"
on public.tasks
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "tasks_org_members_delete"
on public.tasks
for delete
using (public.is_organization_member(organization_id));

create policy "workflows_org_members_select"
on public.workflows
for select
using (public.is_organization_member(organization_id));

create policy "workflows_org_members_insert"
on public.workflows
for insert
with check (public.is_organization_member(organization_id));

create policy "workflows_org_members_update"
on public.workflows
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "workflows_org_members_delete"
on public.workflows
for delete
using (public.is_organization_member(organization_id));

create policy "workflow_runs_org_members_select"
on public.workflow_runs
for select
using (public.is_organization_member(organization_id));

create policy "workflow_runs_org_members_insert"
on public.workflow_runs
for insert
with check (public.is_organization_member(organization_id));

create policy "workflow_runs_org_members_update"
on public.workflow_runs
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "workflow_runs_org_members_delete"
on public.workflow_runs
for delete
using (public.is_organization_member(organization_id));

create policy "activity_events_org_members_select"
on public.activity_events
for select
using (public.is_organization_member(organization_id));

create policy "activity_events_org_members_insert"
on public.activity_events
for insert
with check (public.is_organization_member(organization_id));

create policy "activity_events_org_members_update"
on public.activity_events
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "activity_events_org_members_delete"
on public.activity_events
for delete
using (public.is_organization_member(organization_id));

create policy "comments_org_members_select"
on public.comments
for select
using (public.is_organization_member(organization_id));

create policy "comments_org_members_insert"
on public.comments
for insert
with check (public.is_organization_member(organization_id));

create policy "comments_org_members_update"
on public.comments
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

create policy "comments_org_members_delete"
on public.comments
for delete
using (public.is_organization_member(organization_id));