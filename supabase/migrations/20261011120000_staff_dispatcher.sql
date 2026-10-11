-- Phase 2 AI staff: the Dispatcher (docs/ai-staff.md → "Dispatcher").
--
-- 1. Where the business is (companies.latitude / longitude), geocoded once from the Google
--    listing (Places API New) for the weather forecast.
-- 2. A cell number per team member (organization_memberships.phone_e164) for crew schedule
--    texts. Set through the server (members set their own, owners/admins anyone's).
-- 3. dispatch_messages: every text the Dispatcher sends or queues (on-our-way, crew schedule
--    and updates, weather / day moves, gap offers) — the idempotency ledger (one row per
--    kind + dedupe key) and the queue for customer texts held until 09:00.
-- 4. dispatch_runs: one claim per company per pass (the daily weather check, one gap per
--    vacated slot), so overlapping workers never ask the owner twice.
-- 5. dispatch_weather_cache: the last forecast per company (refreshed at most hourly).
--
-- Additive only and re-runnable. All writes go through the server (service role); members may
-- READ their org's dispatch rows. Nothing here is client-writable (20261006170000: column
-- grants are an allowlist, so the new companies / organization_memberships columns stay
-- locked to the service role).
-- Rollback: supabase/rollback/20261011120000_staff_dispatcher.down.sql

-- ── Company location (weather) ──────────────────────────────────────────────────────
alter table public.companies add column if not exists latitude double precision;
alter table public.companies add column if not exists longitude double precision;
alter table public.companies add column if not exists location_source text;
alter table public.companies add column if not exists location_checked_at timestamptz;
comment on column public.companies.latitude is
  'Business location for the Dispatcher''s weather checks (geocoded from google_place_id or the address; service role only).';
comment on column public.companies.location_checked_at is
  'Last geocoding attempt (a failed lookup is retried after 7 days).';

-- ── Crew cell numbers ───────────────────────────────────────────────────────────────
alter table public.organization_memberships add column if not exists phone_e164 text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organization_memberships_phone_e164_format') then
    alter table public.organization_memberships
      add constraint organization_memberships_phone_e164_format
      check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
  end if;
end $$;
comment on column public.organization_memberships.phone_e164 is
  'Team member''s cell (E.164) for the Dispatcher''s crew schedule texts. Written by the server only.';

-- ── Texts the Dispatcher sends / queues ─────────────────────────────────────────────
create table if not exists public.dispatch_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  kind text not null check (kind in ('on_our_way', 'crew_schedule', 'crew_update', 'job_moved', 'gap_offer')),
  dedupe_key text not null,
  booking_id uuid references public.bookings(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  profile_id uuid references public.profiles(id) on delete set null,
  approval_id uuid references public.owner_approvals(id) on delete set null,
  to_phone text,
  body text,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'skipped', 'failed', 'blocked')),
  reason text,
  not_before timestamptz,
  expires_at timestamptz,
  attempts integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, kind, dedupe_key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists dispatch_messages_queue_idx on public.dispatch_messages (status, not_before) where status = 'queued';
create index if not exists dispatch_messages_booking_idx on public.dispatch_messages (company_id, booking_id, kind, created_at desc);
create index if not exists dispatch_messages_profile_idx on public.dispatch_messages (company_id, profile_id, created_at desc);

-- ── One claim per company per pass ──────────────────────────────────────────────────
create table if not exists public.dispatch_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  kind text not null check (kind in ('weather', 'fill_gap')),
  run_key text not null,
  status text not null default 'running' check (status in ('running', 'done', 'skipped', 'failed')),
  approval_id uuid references public.owner_approvals(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, kind, run_key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── Forecast cache (service role only) ──────────────────────────────────────────────
create table if not exists public.dispatch_weather_cache (
  company_id uuid primary key references public.companies(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  hour_key text not null,
  latitude double precision not null,
  longitude double precision not null,
  forecast jsonb not null,
  fetched_at timestamptz not null default now()
);

-- The Dispatcher's sweeps read recent crew / booking events across companies.
create index if not exists activity_events_dispatch_idx
  on public.activity_events (event_type, created_at)
  where event_type in ('booking.en_route', 'booking.rescheduled', 'booking.status_changed');

-- ── RLS: members read; nobody writes from the browser ───────────────────────────────
alter table public.dispatch_messages enable row level security;
alter table public.dispatch_runs enable row level security;
alter table public.dispatch_weather_cache enable row level security;

drop policy if exists "dispatch_messages_select" on public.dispatch_messages;
create policy "dispatch_messages_select" on public.dispatch_messages
  for select using (public.is_organization_member(organization_id));
drop policy if exists "dispatch_runs_select" on public.dispatch_runs;
create policy "dispatch_runs_select" on public.dispatch_runs
  for select using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.dispatch_messages from anon, authenticated;
revoke insert, update, delete on public.dispatch_runs from anon, authenticated;
revoke select on public.dispatch_messages, public.dispatch_runs from anon;
revoke all on public.dispatch_weather_cache from anon, authenticated;

drop trigger if exists dispatch_messages_set_updated_at on public.dispatch_messages;
create trigger dispatch_messages_set_updated_at before update on public.dispatch_messages
  for each row execute procedure public.touch_updated_at();
drop trigger if exists dispatch_runs_set_updated_at on public.dispatch_runs;
create trigger dispatch_runs_set_updated_at before update on public.dispatch_runs
  for each row execute procedure public.touch_updated_at();
