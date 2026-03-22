create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.membership_role as enum ('owner', 'admin', 'member');
create type public.company_role as enum ('lead', 'member', 'viewer');
create type public.company_stage as enum ('prospect', 'active', 'paused', 'archived');
create type public.contact_stage as enum ('lead', 'qualified', 'customer', 'inactive', 'archived');
create type public.booking_status as enum ('pending', 'confirmed', 'completed', 'cancelled', 'no_show');
create type public.task_status as enum ('todo', 'in_progress', 'blocked', 'completed', 'cancelled');
create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.workflow_status as enum ('draft', 'active', 'paused', 'archived');
create type public.workflow_run_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.comment_entity_type as enum ('company', 'contact', 'booking', 'task', 'workflow', 'workflow_run', 'activity_event');

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
  set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    updated_at = timezone('utc', now());

  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email citext not null unique,
  full_name text,
  avatar_url text,
  default_organization_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  billing_email citext,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.profiles
  add constraint profiles_default_organization_id_fkey
  foreign key (default_organization_id)
  references public.organizations (id)
  on delete set null;

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role public.membership_role not null default 'member',
  joined_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, profile_id)
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  slug text not null,
  stage public.company_stage not null default 'prospect',
  website text,
  notes text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, slug),
  unique (id, organization_id)
);

create table public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role public.company_role not null default 'member',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (company_id, profile_id),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete cascade
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  owner_profile_id uuid references public.profiles (id) on delete set null,
  first_name text not null,
  last_name text,
  email citext,
  phone text,
  stage public.contact_stage not null default 'lead',
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, organization_id),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  contact_id uuid,
  title text not null,
  description text,
  scheduled_for timestamptz not null,
  duration_minutes integer not null default 30 check (duration_minutes > 0),
  status public.booking_status not null default 'pending',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, organization_id),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id)
    on delete set null
);

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  name text not null,
  slug text not null,
  description text,
  status public.workflow_status not null default 'draft',
  trigger_event text not null,
  definition jsonb not null default '{"version":1,"nodes":[],"edges":[]}'::jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, slug),
  unique (id, organization_id),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null
);

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  actor_profile_id uuid references public.profiles (id) on delete set null,
  event_type text not null,
  subject_type text not null,
  subject_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, organization_id),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null
);

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  workflow_id uuid not null,
  trigger_event_id uuid,
  status public.workflow_run_status not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null,
  foreign key (workflow_id, organization_id)
    references public.workflows (id, organization_id)
    on delete cascade,
  foreign key (trigger_event_id, organization_id)
    references public.activity_events (id, organization_id)
    on delete set null
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  contact_id uuid,
  booking_id uuid,
  workflow_id uuid,
  title text not null,
  description text,
  status public.task_status not null default 'todo',
  priority public.task_priority not null default 'medium',
  due_at timestamptz,
  assigned_to_profile_id uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null,
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id)
    on delete set null,
  foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id)
    on delete set null,
  foreign key (workflow_id, organization_id)
    references public.workflows (id, organization_id)
    on delete set null
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid,
  author_profile_id uuid references public.profiles (id) on delete set null,
  entity_type public.comment_entity_type not null,
  entity_id uuid not null,
  body text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
    on delete set null
);

create index organization_memberships_profile_org_idx
  on public.organization_memberships (profile_id, organization_id);
create index organization_memberships_org_role_idx
  on public.organization_memberships (organization_id, role);
create index companies_org_stage_idx
  on public.companies (organization_id, stage, created_at desc);
create index companies_org_name_idx
  on public.companies (organization_id, name);
create index company_memberships_org_profile_idx
  on public.company_memberships (organization_id, profile_id);
create index contacts_org_company_stage_idx
  on public.contacts (organization_id, company_id, stage, created_at desc);
create index contacts_org_email_idx
  on public.contacts (organization_id, email);
create index bookings_org_company_schedule_idx
  on public.bookings (organization_id, company_id, scheduled_for desc);
create index bookings_org_contact_idx
  on public.bookings (organization_id, contact_id);
create index tasks_org_status_due_idx
  on public.tasks (organization_id, status, due_at);
create index tasks_org_assignee_idx
  on public.tasks (organization_id, assigned_to_profile_id, status);
create index workflows_org_status_idx
  on public.workflows (organization_id, status, created_at desc);
create index workflows_org_trigger_idx
  on public.workflows (organization_id, trigger_event);
create index workflow_runs_org_workflow_status_idx
  on public.workflow_runs (organization_id, workflow_id, status, created_at desc);
create index activity_events_org_occurred_idx
  on public.activity_events (organization_id, occurred_at desc);
create index activity_events_org_subject_idx
  on public.activity_events (organization_id, subject_type, subject_id);
create index comments_org_entity_idx
  on public.comments (organization_id, entity_type, entity_id, created_at desc);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.touch_updated_at();

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute procedure public.touch_updated_at();

create trigger organization_memberships_set_updated_at
before update on public.organization_memberships
for each row execute procedure public.touch_updated_at();

create trigger companies_set_updated_at
before update on public.companies
for each row execute procedure public.touch_updated_at();

create trigger company_memberships_set_updated_at
before update on public.company_memberships
for each row execute procedure public.touch_updated_at();

create trigger contacts_set_updated_at
before update on public.contacts
for each row execute procedure public.touch_updated_at();

create trigger bookings_set_updated_at
before update on public.bookings
for each row execute procedure public.touch_updated_at();

create trigger tasks_set_updated_at
before update on public.tasks
for each row execute procedure public.touch_updated_at();

create trigger workflows_set_updated_at
before update on public.workflows
for each row execute procedure public.touch_updated_at();

create trigger workflow_runs_set_updated_at
before update on public.workflow_runs
for each row execute procedure public.touch_updated_at();

create trigger activity_events_set_updated_at
before update on public.activity_events
for each row execute procedure public.touch_updated_at();

create trigger comments_set_updated_at
before update on public.comments
for each row execute procedure public.touch_updated_at();

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();