-- Phase 4 — Purchasing (docs/ai-staff.md → "Purchasing"): materials lists, supplier orders, pickups.
--
-- 1. suppliers               where the business buys materials (name, branch, email, phone, account
--                            number, preferred). The account number isn't a secret like a PIN, but
--                            it is the business's: owners/admins read, nobody else.
-- 2. material_recipes        per price-list item: the materials ONE unit of it takes (label, qty per
--                            unit, unit, default supplier, estimated unit cost). Members read.
-- 3. purchase_orders         one order for a job: status draft → approved → sent → confirmed → ready
--                            → picked_up / delivered (or cancelled), PO-<n> per company, needed-by,
--                            pickup/delivery, the lines with estimated costs. Members read (the crew
--                            see the list on the job sheet).
-- 4. purchase_order_drafts   the draft claim: one row per job (unique booking_id), taken by the sweep
--                            and by the owner's order_materials. Service role only.
-- 5. purchasing_daily_counts the draft sweep's per-day question cap (conditional increments).
--                            Service role only.
--
-- One open order per job is enforced by a partial unique index on purchase_orders(booking_id).
-- Orders keep their history when a booking is deleted (booking_id set null; job_label kept).
--
-- Costing: nothing here touches job_materials or expenses (receipts are the actual cost).
-- Settings live in companies.ai_settings.purchasing (no column needed).
--
-- Additive only and re-runnable. All writes go through the server (service role); nothing here is
-- client-writable (see 20261006170000).
-- Rollback: supabase/rollback/20261013130000_staff_purchasing.down.sql

-- ── 1. suppliers ─────────────────────────────────────────────────────────────────────
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80),
  branch text check (branch is null or length(branch) <= 80),
  email text check (email is null or length(email) <= 254),
  phone text check (phone is null or phone ~ '^\+[0-9]{8,15}$'),
  account_number text check (account_number is null or length(account_number) <= 60),
  preferred boolean not null default false,
  notes text check (notes is null or length(notes) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists suppliers_company_idx on public.suppliers (organization_id, company_id, active);
-- At most one preferred supplier per company.
create unique index if not exists suppliers_one_preferred_idx on public.suppliers (company_id) where preferred and active;

-- ── 2. material_recipes ──────────────────────────────────────────────────────────────
create table if not exists public.material_recipes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  service_catalog_item_id uuid not null references public.service_catalog_items(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 80),
  qty_per_unit numeric(12, 3) not null check (qty_per_unit > 0 and qty_per_unit <= 10000),
  unit text check (unit is null or length(unit) <= 20),
  supplier_id uuid references public.suppliers(id) on delete set null,
  est_unit_cost_cents integer check (est_unit_cost_cents is null or (est_unit_cost_cents >= 0 and est_unit_cost_cents <= 5000000)),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists material_recipes_item_idx on public.material_recipes (company_id, service_catalog_item_id, sort_order);

-- ── 3. purchase_orders ───────────────────────────────────────────────────────────────
create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  -- set null, not cascade: the order history (and its job_label) outlives a deleted booking.
  booking_id uuid references public.bookings(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  -- Snapshot of the supplier's name (+ branch): members read the PO but not the suppliers table.
  supplier_name text,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'sent', 'confirmed', 'ready', 'picked_up', 'delivered', 'cancelled')),
  po_seq integer not null check (po_seq > 0),
  po_number text not null,
  needed_by date,
  fulfilment text not null default 'pickup' check (fulfilment in ('pickup', 'delivery')),
  -- [{label, qty, unit, estUnitCostCents, source: recipe|ai|owner}]
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  est_total_cents bigint not null default 0 check (est_total_cents >= 0),
  basis text not null default 'recipe' check (basis in ('recipe', 'ai', 'mixed', 'owner')),
  source text not null default 'auto' check (source in ('auto', 'owner')),
  approval_id uuid references public.owner_approvals(id) on delete set null,
  sent_at timestamptz,
  -- 'email' | 'owner_call_in'
  sent_via text,
  sent_to text,
  send_error text,
  reminder_sent_at timestamptz,
  status_changed_at timestamptz,
  cancel_reason text,
  notes text,
  -- The job's name and start when ordered: kept if the booking is deleted; a move is noticed.
  job_label text,
  job_scheduled_for timestamptz,
  -- The last job change the owner was told about ('moved:<iso>' | 'cancelled').
  job_change_notice text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, po_seq),
  unique (company_id, po_number),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- Re-runnable on a database that has the first version of this table.
alter table public.purchase_orders add column if not exists job_label text;
alter table public.purchase_orders add column if not exists job_scheduled_for timestamptz;
alter table public.purchase_orders add column if not exists job_change_notice text;
alter table public.purchase_orders alter column est_total_cents type bigint;
alter table public.purchase_orders drop constraint if exists purchase_orders_booking_id_fkey;
alter table public.purchase_orders add constraint purchase_orders_booking_id_fkey foreign key (booking_id) references public.bookings(id) on delete set null;

create index if not exists purchase_orders_booking_idx on public.purchase_orders (booking_id);
-- One open order per job: the sweep and the owner's order_materials can never both draft (→ 23505).
create unique index if not exists purchase_orders_one_open_per_booking_idx on public.purchase_orders (booking_id)
  where status <> 'cancelled' and booking_id is not null;
create index if not exists purchase_orders_company_status_idx on public.purchase_orders (organization_id, company_id, status);
create index if not exists purchase_orders_approval_idx on public.purchase_orders (approval_id) where approval_id is not null;

-- ── 4. purchase_order_drafts (the draft sweep's claim) ──────────────────────────────────
create table if not exists public.purchase_order_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  outcome text not null default 'working' check (outcome in ('working', 'asked', 'no_materials', 'already_ordered', 'failed')),
  attempts integer not null default 1 check (attempts >= 1),
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists purchase_order_drafts_company_idx on public.purchase_order_drafts (company_id, outcome, updated_at);
alter table public.purchase_order_drafts drop constraint if exists purchase_order_drafts_outcome_check;
alter table public.purchase_order_drafts add constraint purchase_order_drafts_outcome_check check (outcome in ('working', 'asked', 'no_materials', 'already_ordered', 'failed'));

-- ── 5. purchasing_daily_counts (the draft sweep's per-day question cap) ───────────────────
create table if not exists public.purchasing_daily_counts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  local_date date not null,
  asked integer not null default 0 check (asked >= 0),
  created_at timestamptz not null default now(),
  unique (company_id, local_date),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── RLS + grants: members read recipes and orders, owners/admins read suppliers, nobody writes ──
alter table public.suppliers enable row level security;
alter table public.material_recipes enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_drafts enable row level security;
alter table public.purchasing_daily_counts enable row level security;

drop policy if exists "suppliers_select" on public.suppliers;
create policy "suppliers_select" on public.suppliers
  for select using (public.is_organization_admin(organization_id));

drop policy if exists "material_recipes_select" on public.material_recipes;
create policy "material_recipes_select" on public.material_recipes
  for select using (public.is_organization_member(organization_id));

drop policy if exists "purchase_orders_select" on public.purchase_orders;
create policy "purchase_orders_select" on public.purchase_orders
  for select using (public.is_organization_member(organization_id));

revoke insert, update, delete on public.suppliers, public.material_recipes, public.purchase_orders, public.purchase_order_drafts, public.purchasing_daily_counts from anon, authenticated;
revoke select on public.suppliers, public.material_recipes, public.purchase_orders, public.purchase_order_drafts, public.purchasing_daily_counts from anon;
revoke select on public.purchase_order_drafts, public.purchasing_daily_counts from authenticated;
grant select on public.suppliers, public.material_recipes, public.purchase_orders to authenticated;
grant all on public.suppliers, public.material_recipes, public.purchase_orders, public.purchase_order_drafts, public.purchasing_daily_counts to service_role;

drop trigger if exists suppliers_set_updated_at on public.suppliers;
create trigger suppliers_set_updated_at before update on public.suppliers
  for each row execute procedure public.touch_updated_at();
drop trigger if exists material_recipes_set_updated_at on public.material_recipes;
create trigger material_recipes_set_updated_at before update on public.material_recipes
  for each row execute procedure public.touch_updated_at();
drop trigger if exists purchase_orders_set_updated_at on public.purchase_orders;
create trigger purchase_orders_set_updated_at before update on public.purchase_orders
  for each row execute procedure public.touch_updated_at();
drop trigger if exists purchase_order_drafts_set_updated_at on public.purchase_order_drafts;
create trigger purchase_order_drafts_set_updated_at before update on public.purchase_order_drafts
  for each row execute procedure public.touch_updated_at();

comment on table public.suppliers is 'Purchasing: where the business buys materials. Owners/admins read (account numbers); service role writes.';
comment on table public.material_recipes is 'Purchasing: the materials one unit of a price-list item takes. Members read; service role writes.';
comment on table public.purchase_orders is 'Purchasing: materials orders for jobs (PO-<n> per company). Members read; service role writes. Never feeds job costing (receipts do).';
comment on table public.purchasing_daily_counts is 'Purchasing: materials_order questions the draft sweep asked per company per local day (the cap). Service role only.';
comment on table public.purchase_order_drafts is 'Purchasing: the draft sweep''s per-job claim. Service role only.';
