-- EmpireVu Mobile (iOS + Android): device push tokens, per-user notification preferences,
-- and job photos (private Storage bucket + metadata table).

-- ── 1) device_tokens — one row per app install ───────────────────────────────
-- A user may have several installs. Tokens are unique across users: the API upserts by
-- token, so a shared device's token moves to whoever signed in last. The send path and
-- that cross-user upsert run with the service role; users only ever see their own rows.
create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  app_version text,
  created_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  revoked_at timestamptz
);

create index if not exists device_tokens_active_org_user_idx
  on public.device_tokens (organization_id, user_id)
  where revoked_at is null;

alter table public.device_tokens enable row level security;

create policy "device_tokens_own_select"
  on public.device_tokens for select
  using (user_id = auth.uid());
create policy "device_tokens_own_insert"
  on public.device_tokens for insert
  with check (user_id = auth.uid() and public.is_organization_member(organization_id));
create policy "device_tokens_own_update"
  on public.device_tokens for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "device_tokens_own_delete"
  on public.device_tokens for delete
  using (user_id = auth.uid());

-- ── 2) notification_preferences — enforced server-side, not on device ───────────
create table if not exists public.notification_preferences (
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  leads boolean not null default true,
  drafts boolean not null default true,
  payments boolean not null default true,
  conflicts boolean not null default true,
  workflow_failures boolean not null default false,
  daily_digest boolean not null default true,
  -- Local wall-clock window; urgent pushes still break through.
  quiet_hours_start time,
  quiet_hours_end time,
  timezone text,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, organization_id)
);

alter table public.notification_preferences enable row level security;

create policy "notification_preferences_own_select"
  on public.notification_preferences for select
  using (user_id = auth.uid());
create policy "notification_preferences_own_insert"
  on public.notification_preferences for insert
  with check (user_id = auth.uid() and public.is_organization_member(organization_id));
create policy "notification_preferences_own_update"
  on public.notification_preferences for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_organization_member(organization_id));

-- ── 3) job_photos — the photo list reads this table, never a storage listing ───
create table if not exists public.job_photos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  storage_path text not null unique,
  caption text,
  taken_by uuid references public.profiles (id) on delete set null,
  taken_at timestamptz not null default timezone('utc', now()),
  width integer,
  height integer,
  bytes integer,
  -- Location is stored explicitly here when wanted; the app strips GPS EXIF from files.
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists job_photos_booking_idx
  on public.job_photos (organization_id, booking_id, taken_at desc);

alter table public.job_photos enable row level security;

create policy "job_photos_members_select"
  on public.job_photos for select
  using (public.is_organization_member(organization_id));
create policy "job_photos_members_insert"
  on public.job_photos for insert
  with check (public.is_organization_member(organization_id) and taken_by = auth.uid());
create policy "job_photos_owner_or_admin_delete"
  on public.job_photos for delete
  using (taken_by = auth.uid() or public.is_organization_admin(organization_id));

-- ── 4) Storage: private `job-photos` bucket ────────────────────────────────────
-- Path: {organization_id}/{company_id}/{booking_id}/{uuid}.jpg. The org id leads the path,
-- so access is a prefix check against the caller's memberships. Never public: reads use
-- short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-photos', 'job-photos', false, 10485760, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "job_photos_members_read" on storage.objects;
create policy "job_photos_members_read"
  on storage.objects for select
  using (
    bucket_id = 'job-photos'
    and exists (
      select 1 from public.organization_memberships membership
      where membership.profile_id = auth.uid()
        and membership.organization_id::text = (storage.foldername(name))[1]
    )
  );

drop policy if exists "job_photos_members_write" on storage.objects;
create policy "job_photos_members_write"
  on storage.objects for insert
  with check (
    bucket_id = 'job-photos'
    and exists (
      select 1 from public.organization_memberships membership
      where membership.profile_id = auth.uid()
        and membership.organization_id::text = (storage.foldername(name))[1]
    )
  );
