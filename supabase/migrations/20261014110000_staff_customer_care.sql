-- Phase 5 — Customer care & warranty (docs/ai-staff.md → "Customer care & warranty"):
-- post-job check-ins, care cases (complaints, callbacks, warranty claims), warranty terms and
-- job warranties, installed equipment.
--
-- 1. warranty_terms        per price-list item: a workmanship warranty that overrides the
--                          company default (ai_settings.customer_care.warranty). Members read.
-- 2. job_warranties        one per completed job (unique booking_id): starts / ends, months, the
--                          terms text as it stood when the job was done. Members read.
-- 3. installed_equipment   what was installed for a customer (make, model, serial, manufacturer
--                          warranty end). Members read.
-- 4. care_checkins         the one check-in text per completed job (unique booking_id): when it
--                          goes, what happened, the customer's rating / comment. Owners/admins read.
-- 5. care_cases            complaints, callbacks and warranty claims: status open → scheduled →
--                          resolved / closed, how it was opened, the owner's follow-up choice, the
--                          visit offer. Owners/admins read.
-- 6. care_case_bookings    callback / warranty visits (bookings) linked to their case (unique
--                          booking_id). invoices/auto.ts never auto-invoices these. Members read.
-- 7. care_messages         the customer-text outbox (visit offers, "Mike will call you", …), unique
--                          per (company, kind, dedupe key). Service role only.
-- 8. care_checkin_claims   one check-in per customer per local day (claimed before the send, so two
--                          workers / two jobs can't both text them). Service role only.
--
-- No column is added to bookings. Settings live in companies.ai_settings.customer_care.
-- Additive only and re-runnable. All writes go through the server (service role); nothing here
-- is client-writable (see 20261006170000).
-- Rollback: supabase/rollback/20261014110000_staff_customer_care.down.sql

-- ── 1. warranty_terms ────────────────────────────────────────────────────────────────
create table if not exists public.warranty_terms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  service_catalog_item_id uuid not null references public.service_catalog_items(id) on delete cascade,
  -- 0 = no workmanship warranty on this item.
  months integer not null check (months between 0 and 600),
  terms_text text check (terms_text is null or length(terms_text) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, service_catalog_item_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── 2. job_warranties ────────────────────────────────────────────────────────────────
create table if not exists public.job_warranties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid references public.contacts(id) on delete set null,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  job_label text check (job_label is null or length(job_label) <= 200),
  starts_on date not null,
  ends_on date not null,
  months integer not null check (months between 1 and 600),
  terms_text text check (terms_text is null or length(terms_text) <= 500),
  -- 'default' (the company's) | 'item' (a price-list item's override)
  source text not null default 'default' check (source in ('default', 'item')),
  created_at timestamptz not null default now(),
  unique (booking_id),
  check (ends_on >= starts_on),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists job_warranties_contact_idx on public.job_warranties (organization_id, company_id, contact_id, starts_on desc);

-- ── 3. installed_equipment ───────────────────────────────────────────────────────────
create table if not exists public.installed_equipment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid references public.contacts(id) on delete set null,
  booking_id uuid references public.bookings(id) on delete set null,
  make text check (make is null or length(make) <= 80),
  model text check (model is null or length(model) <= 80),
  serial text check (serial is null or length(serial) <= 80),
  installed_on date,
  manufacturer_warranty_ends date,
  notes text check (notes is null or length(notes) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (make is not null or model is not null),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists installed_equipment_contact_idx on public.installed_equipment (organization_id, company_id, contact_id) where active;

-- ── 4. care_checkins ─────────────────────────────────────────────────────────────────
create table if not exists public.care_checkins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid references public.contacts(id) on delete set null,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'sent', 'skipped', 'blocked', 'failed')),
  send_at timestamptz not null,
  -- Times the check-in moved a day to stay clear of a review request (at most 3).
  pushes integer not null default 0 check (pushes between 0 and 10),
  sent_at timestamptz,
  body text check (body is null or length(body) <= 1000),
  reason text check (reason is null or length(reason) <= 300),
  job_label text check (job_label is null or length(job_label) <= 200),
  rating integer check (rating is null or rating between 1 and 5),
  comment text check (comment is null or length(comment) <= 1000),
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists care_checkins_due_idx on public.care_checkins (status, send_at) where status = 'scheduled';
create index if not exists care_checkins_contact_idx on public.care_checkins (organization_id, company_id, contact_id, sent_at desc);

-- ── 5. care_cases ────────────────────────────────────────────────────────────────────
create table if not exists public.care_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid references public.contacts(id) on delete set null,
  -- The job the case is about (set null if that booking is deleted; job_label is kept).
  booking_id uuid references public.bookings(id) on delete set null,
  job_label text check (job_label is null or length(job_label) <= 200),
  kind text not null check (kind in ('complaint', 'callback', 'warranty')),
  status text not null default 'open' check (status in ('open', 'scheduled', 'resolved', 'closed')),
  summary text check (summary is null or length(summary) <= 1000),
  rating integer check (rating is null or rating between 1 and 5),
  opened_via text not null check (opened_via in ('checkin', 'sms_agent', 'owner')),
  checkin_id uuid references public.care_checkins(id) on delete set null,
  warranty_id uuid references public.job_warranties(id) on delete set null,
  equipment_id uuid references public.installed_equipment(id) on delete set null,
  -- The owner's choice: 'visit' | 'call' | 'none' (N) | 'expired'; claimed once (decided_at).
  followup text check (followup is null or followup in ('visit', 'call', 'none', 'expired')),
  followup_decided_at timestamptz,
  -- The visit offer: 'callback' | 'warranty'; stage offered → booked, or owner_calls.
  visit_kind text check (visit_kind is null or visit_kind in ('callback', 'warranty')),
  visit_stage text check (visit_stage is null or visit_stage in ('offered', 'booking', 'booked', 'owner_calls')),
  offered_slots jsonb not null default '[]'::jsonb check (jsonb_typeof(offered_slots) = 'array'),
  offered_at timestamptz,
  -- The owner's text about a low rating (both care_followup codes in one text).
  owner_alert_body text check (owner_alert_body is null or length(owner_alert_body) <= 700),
  owner_alert_status text check (owner_alert_status is null or owner_alert_status in ('pending', 'sending', 'sent', 'none')),
  owner_alerted_at timestamptz,
  approval_ids uuid[] not null default '{}',
  notes text check (notes is null or length(notes) <= 2000),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- One case per check-in answer; one open warranty claim per customer.
create unique index if not exists care_cases_checkin_idx on public.care_cases (checkin_id) where checkin_id is not null;
-- (Only while open: a claim whose visit is booked doesn't block the next one.)
drop index if exists public.care_cases_one_open_warranty_idx;
create unique index care_cases_one_open_warranty_idx on public.care_cases (company_id, contact_id)
  where kind = 'warranty' and status = 'open' and contact_id is not null;
create index if not exists care_cases_company_status_idx on public.care_cases (organization_id, company_id, status, created_at desc);
create index if not exists care_cases_alert_idx on public.care_cases (owner_alert_status) where owner_alert_status = 'pending';

-- ── 6. care_case_bookings ────────────────────────────────────────────────────────────
create table if not exists public.care_case_bookings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  case_id uuid not null references public.care_cases(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  kind text not null check (kind in ('callback', 'warranty')),
  created_at timestamptz not null default now(),
  unique (booking_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists care_case_bookings_case_idx on public.care_case_bookings (case_id);

-- ── 7. care_messages (customer-text outbox) ────────────────────────────────────────────
create table if not exists public.care_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  case_id uuid references public.care_cases(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  kind text not null check (kind in ('visit_offer', 'owner_call', 'no_times')),
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'skipped', 'failed', 'blocked')),
  body text not null check (length(body) <= 1000),
  not_before timestamptz not null default now(),
  attempts integer not null default 0,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, kind, dedupe_key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists care_messages_due_idx on public.care_messages (status, not_before) where status = 'queued';

-- ── 8. care_checkin_claims (one check-in per customer per local day, across workers) ──────
create table if not exists public.care_checkin_claims (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  local_date date not null,
  checkin_id uuid references public.care_checkins(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (company_id, contact_id, local_date),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── RLS + grants ─────────────────────────────────────────────────────────────────────
-- Members read terms, warranties, equipment and visit links; owners/admins read check-ins and
-- cases (customers' complaints); the outbox is service role only. Nobody writes from a client.
alter table public.warranty_terms enable row level security;
alter table public.job_warranties enable row level security;
alter table public.installed_equipment enable row level security;
alter table public.care_checkins enable row level security;
alter table public.care_cases enable row level security;
alter table public.care_case_bookings enable row level security;
alter table public.care_messages enable row level security;
alter table public.care_checkin_claims enable row level security;

drop policy if exists "warranty_terms_select" on public.warranty_terms;
create policy "warranty_terms_select" on public.warranty_terms
  for select using (public.is_organization_member(organization_id));

drop policy if exists "job_warranties_select" on public.job_warranties;
create policy "job_warranties_select" on public.job_warranties
  for select using (public.is_organization_member(organization_id));

drop policy if exists "installed_equipment_select" on public.installed_equipment;
create policy "installed_equipment_select" on public.installed_equipment
  for select using (public.is_organization_member(organization_id));

drop policy if exists "care_case_bookings_select" on public.care_case_bookings;
create policy "care_case_bookings_select" on public.care_case_bookings
  for select using (public.is_organization_member(organization_id));

drop policy if exists "care_checkins_select" on public.care_checkins;
create policy "care_checkins_select" on public.care_checkins
  for select using (public.is_organization_admin(organization_id));

drop policy if exists "care_cases_select" on public.care_cases;
create policy "care_cases_select" on public.care_cases
  for select using (public.is_organization_admin(organization_id));

revoke insert, update, delete on public.warranty_terms, public.job_warranties, public.installed_equipment, public.care_checkins, public.care_cases, public.care_case_bookings, public.care_messages, public.care_checkin_claims from anon, authenticated;
revoke select on public.warranty_terms, public.job_warranties, public.installed_equipment, public.care_checkins, public.care_cases, public.care_case_bookings, public.care_messages, public.care_checkin_claims from anon;
revoke select on public.care_messages, public.care_checkin_claims from authenticated;
grant select on public.warranty_terms, public.job_warranties, public.installed_equipment, public.care_checkins, public.care_cases, public.care_case_bookings to authenticated;
grant all on public.warranty_terms, public.job_warranties, public.installed_equipment, public.care_checkins, public.care_cases, public.care_case_bookings, public.care_messages, public.care_checkin_claims to service_role;

drop trigger if exists warranty_terms_set_updated_at on public.warranty_terms;
create trigger warranty_terms_set_updated_at before update on public.warranty_terms
  for each row execute procedure public.touch_updated_at();
drop trigger if exists installed_equipment_set_updated_at on public.installed_equipment;
create trigger installed_equipment_set_updated_at before update on public.installed_equipment
  for each row execute procedure public.touch_updated_at();
drop trigger if exists care_checkins_set_updated_at on public.care_checkins;
create trigger care_checkins_set_updated_at before update on public.care_checkins
  for each row execute procedure public.touch_updated_at();
drop trigger if exists care_cases_set_updated_at on public.care_cases;
create trigger care_cases_set_updated_at before update on public.care_cases
  for each row execute procedure public.touch_updated_at();
drop trigger if exists care_messages_set_updated_at on public.care_messages;
create trigger care_messages_set_updated_at before update on public.care_messages
  for each row execute procedure public.touch_updated_at();

comment on table public.warranty_terms is 'Customer care: per price-list item workmanship warranty (overrides the company default). Members read; service role writes.';
comment on table public.job_warranties is 'Customer care: the workmanship warranty of each completed job. Members read; service role writes.';
comment on table public.installed_equipment is 'Customer care: equipment installed for a customer (manufacturer warranty end). Members read; service role writes.';
comment on table public.care_checkins is 'Customer care: the one post-job check-in text per job, and the answer. Never gates review requests. Owners/admins read; service role writes.';
comment on table public.care_cases is 'Customer care: complaints, callbacks and warranty claims. Owners/admins read; service role writes.';
comment on table public.care_case_bookings is 'Customer care: callback / warranty visits linked to their case. Never auto-invoiced. Members read; service role writes.';
comment on table public.care_checkin_claims is 'Customer care: one check-in per customer per local day (the send claim). Service role only.';
comment on table public.care_messages is 'Customer care: customer-text outbox (09:00-20:00 local). Service role only.';
