-- Phase 5 — Fleet & equipment (docs/ai-staff.md → "Fleet & equipment"): vehicles, equipment, rentals.
--
-- 1. vehicles               "Truck 2": year/make/model, plate, VIN, assigned crew member, the last
--                           odometer reading (km, when) and the average km/day worked out from the
--                           readings, the plate sticker renewal date (Ontario stickers still need
--                           renewing though the fee is $0) and the annual safety inspection (only
--                           for vehicles that need one). Members read.
-- 2. vehicle_service_items  service schedules per vehicle ("Oil change" every 8,000 km and/or every
--                           6 months; last done km/date). Members read.
-- 3. equipment              tools and machines: serial, value, status (available | out | in_shop |
--                           retired), where it is / which job, service interval (hours and/or
--                           months), last serviced. Members read.
-- 4. rentals                rented gear: item, vendor + phone, job (optional), out, due back, rate
--                           per day, returned. Members read.
-- 5. fleet_log              odometer / hour readings, services done, check-outs / check-ins,
--                           rentals out / back. Members read. `source_key` (unique per company)
--                           makes a texted reading idempotent.
-- 6. fleet_reminders        the reminder sweep's claims: one row per (subject, stage) and one per
--                           company per day-slot ("one text a day"). Service role only.
--
-- Settings live in companies.ai_settings.fleet (no column needed). Vehicle insurance stays with
-- Compliance (compliance_documents kind vehicle_insurance); nothing here duplicates it.
--
-- Additive only and re-runnable. All writes go through the server (service role); nothing here is
-- client-writable (see 20261006170000).
-- Rollback: supabase/rollback/20261014130000_staff_fleet.down.sql

-- ── 1. vehicles ──────────────────────────────────────────────────────────────────────
create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 60),
  year integer check (year is null or year between 1950 and 2100),
  make text check (make is null or length(make) <= 40),
  model text check (model is null or length(model) <= 60),
  plate text check (plate is null or length(plate) <= 12),
  vin text check (vin is null or vin ~ '^[A-Z0-9]{5,17}$'),
  profile_id uuid references public.profiles(id) on delete set null,
  odometer_km integer check (odometer_km is null or odometer_km between 0 and 3000000),
  odometer_at timestamptz,
  avg_km_per_day numeric(8, 1) check (avg_km_per_day is null or (avg_km_per_day >= 0 and avg_km_per_day <= 2000)),
  plate_sticker_due date,
  safety_inspection_required boolean not null default false,
  safety_inspection_due date,
  notes text check (notes is null or length(notes) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists vehicles_company_idx on public.vehicles (organization_id, company_id, active);
-- One active "Truck 2" per company (the owner's texts name vehicles).
create unique index if not exists vehicles_one_name_idx on public.vehicles (company_id, lower(btrim(name))) where active;

-- ── 2. vehicle_service_items ─────────────────────────────────────────────────────────
create table if not exists public.vehicle_service_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 60),
  every_km integer check (every_km is null or every_km between 100 and 200000),
  every_months integer check (every_months is null or every_months between 1 and 60),
  last_done_km integer check (last_done_km is null or last_done_km between 0 and 3000000),
  last_done_on date,
  notes text check (notes is null or length(notes) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vehicle_service_items_interval_check check (every_km is not null or every_months is not null),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists vehicle_service_items_vehicle_idx on public.vehicle_service_items (vehicle_id, active);
create index if not exists vehicle_service_items_company_idx on public.vehicle_service_items (company_id, active);
create unique index if not exists vehicle_service_items_one_label_idx on public.vehicle_service_items (vehicle_id, lower(btrim(label))) where active;

-- ── 3. equipment ─────────────────────────────────────────────────────────────────────
create table if not exists public.equipment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 60),
  serial text check (serial is null or length(serial) <= 60),
  value_cents bigint check (value_cents is null or (value_cents >= 0 and value_cents <= 10000000000)),
  status text not null default 'available' check (status in ('available', 'out', 'in_shop', 'retired')),
  location text check (location is null or length(location) <= 120),
  -- set null: the equipment outlives a deleted job.
  booking_id uuid references public.bookings(id) on delete set null,
  out_at timestamptz,
  out_profile_id uuid references public.profiles(id) on delete set null,
  hours numeric(10, 1) check (hours is null or (hours >= 0 and hours <= 1000000)),
  service_every_hours numeric(8, 1) check (service_every_hours is null or (service_every_hours > 0 and service_every_hours <= 100000)),
  service_every_months integer check (service_every_months is null or service_every_months between 1 and 60),
  last_serviced_on date,
  last_serviced_hours numeric(10, 1) check (last_serviced_hours is null or (last_serviced_hours >= 0 and last_serviced_hours <= 1000000)),
  notes text check (notes is null or length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists equipment_company_idx on public.equipment (organization_id, company_id, status);
create unique index if not exists equipment_one_name_idx on public.equipment (company_id, lower(btrim(name))) where status <> 'retired';

-- ── 4. rentals ───────────────────────────────────────────────────────────────────────
create table if not exists public.rentals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  item text not null check (length(btrim(item)) between 1 and 80),
  vendor text check (vendor is null or length(vendor) <= 80),
  vendor_phone text check (vendor_phone is null or vendor_phone ~ '^\+[0-9]{8,15}$'),
  booking_id uuid references public.bookings(id) on delete set null,
  out_at timestamptz,
  due_back_at timestamptz,
  rate_cents_per_day integer check (rate_cents_per_day is null or (rate_cents_per_day >= 0 and rate_cents_per_day <= 10000000)),
  returned_at timestamptz,
  notes text check (notes is null or length(notes) <= 500),
  created_via text not null default 'owner_sms' check (created_via in ('owner_sms', 'settings')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists rentals_company_open_idx on public.rentals (organization_id, company_id) where returned_at is null;
create index if not exists rentals_open_due_idx on public.rentals (due_back_at) where returned_at is null;

-- ── 5. fleet_log ─────────────────────────────────────────────────────────────────────
create table if not exists public.fleet_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  vehicle_id uuid references public.vehicles(id) on delete cascade,
  equipment_id uuid references public.equipment(id) on delete cascade,
  rental_id uuid references public.rentals(id) on delete cascade,
  service_item_id uuid references public.vehicle_service_items(id) on delete set null,
  kind text not null check (kind in ('odometer', 'hours', 'service', 'check_out', 'check_in', 'rental_out', 'rental_returned')),
  -- km for odometer / a vehicle service; hours for an hour meter / equipment service.
  reading numeric(12, 1) check (reading is null or reading >= 0),
  label text check (label is null or length(label) <= 80),
  booking_id uuid references public.bookings(id) on delete set null,
  profile_id uuid references public.profiles(id) on delete set null,
  source text not null default 'owner_sms' check (source in ('owner_sms', 'owner_photo', 'settings', 'system')),
  source_key text check (source_key is null or length(source_key) <= 120),
  happened_at timestamptz not null default now(),
  notes text check (notes is null or length(notes) <= 500),
  created_at timestamptz not null default now(),
  constraint fleet_log_one_subject_check check (num_nonnulls(vehicle_id, equipment_id, rental_id) = 1),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists fleet_log_vehicle_idx on public.fleet_log (vehicle_id, kind, happened_at) where vehicle_id is not null;
create index if not exists fleet_log_equipment_idx on public.fleet_log (equipment_id, happened_at) where equipment_id is not null;
create index if not exists fleet_log_company_idx on public.fleet_log (organization_id, company_id, happened_at);
-- One filing per texted reading (a redelivered text logs nothing twice).
create unique index if not exists fleet_log_source_key_idx on public.fleet_log (company_id, source_key) where source_key is not null;

-- ── 6. fleet_reminders (the sweep's claims) ──────────────────────────────────────────
create table if not exists public.fleet_reminders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  subject_type text not null check (subject_type in ('company', 'vehicle', 'service_item', 'equipment', 'rental')),
  subject_id uuid not null,
  reminder_key text not null check (length(reminder_key) between 1 and 160),
  local_date date not null,
  created_at timestamptz not null default now(),
  unique (company_id, subject_type, subject_id, reminder_key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists fleet_reminders_company_idx on public.fleet_reminders (company_id, local_date);
-- The sweep prunes claims older than 90 days by local_date.
create index if not exists fleet_reminders_local_date_idx on public.fleet_reminders (local_date);

-- ── RLS + grants: members read the fleet, nobody writes; the claims are service role only ──
alter table public.vehicles enable row level security;
alter table public.vehicle_service_items enable row level security;
alter table public.equipment enable row level security;
alter table public.rentals enable row level security;
alter table public.fleet_log enable row level security;
alter table public.fleet_reminders enable row level security;

drop policy if exists "vehicles_select" on public.vehicles;
create policy "vehicles_select" on public.vehicles
  for select using (public.is_organization_member(organization_id));

drop policy if exists "vehicle_service_items_select" on public.vehicle_service_items;
create policy "vehicle_service_items_select" on public.vehicle_service_items
  for select using (public.is_organization_member(organization_id));

drop policy if exists "equipment_select" on public.equipment;
create policy "equipment_select" on public.equipment
  for select using (public.is_organization_member(organization_id));

drop policy if exists "rentals_select" on public.rentals;
create policy "rentals_select" on public.rentals
  for select using (public.is_organization_member(organization_id));

drop policy if exists "fleet_log_select" on public.fleet_log;
create policy "fleet_log_select" on public.fleet_log
  for select using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.vehicles, public.vehicle_service_items, public.equipment, public.rentals, public.fleet_log, public.fleet_reminders from anon, authenticated;
revoke select on public.vehicles, public.vehicle_service_items, public.equipment, public.rentals, public.fleet_log, public.fleet_reminders from anon;
revoke select on public.fleet_reminders from authenticated;
grant select on public.vehicles, public.vehicle_service_items, public.equipment, public.rentals, public.fleet_log to authenticated;
grant all on public.vehicles, public.vehicle_service_items, public.equipment, public.rentals, public.fleet_log, public.fleet_reminders to service_role;

drop trigger if exists vehicles_set_updated_at on public.vehicles;
create trigger vehicles_set_updated_at before update on public.vehicles
  for each row execute procedure public.touch_updated_at();
drop trigger if exists vehicle_service_items_set_updated_at on public.vehicle_service_items;
create trigger vehicle_service_items_set_updated_at before update on public.vehicle_service_items
  for each row execute procedure public.touch_updated_at();
drop trigger if exists equipment_set_updated_at on public.equipment;
create trigger equipment_set_updated_at before update on public.equipment
  for each row execute procedure public.touch_updated_at();
drop trigger if exists rentals_set_updated_at on public.rentals;
create trigger rentals_set_updated_at before update on public.rentals
  for each row execute procedure public.touch_updated_at();

comment on table public.vehicles is 'Fleet: the business''s vehicles (odometer, plate sticker, safety inspection). Members read; service role writes.';
comment on table public.vehicle_service_items is 'Fleet: service schedules per vehicle (every N km and/or N months). Members read; service role writes.';
comment on table public.equipment is 'Fleet: tools and machines (status, where, service interval). Members read; service role writes.';
comment on table public.rentals is 'Fleet: rented equipment (due back, rate per day). Members read; service role writes.';
comment on table public.fleet_log is 'Fleet: odometer/hour readings, services, check-outs, rentals out/back. Members read; service role writes.';
comment on table public.fleet_reminders is 'Fleet: the reminder sweep''s per-stage and per-day claims. Service role only.';
