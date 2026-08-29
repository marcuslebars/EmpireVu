-- Tenant-configurable service catalog.
--
-- Replaces the hard compile-time dependency on @a1/pricing-engine. Until now every
-- quote in the product was priced by one customer's boat-storage rate card, which
-- meant a second tenant had no way to express their own prices at all.
--
-- The pricing MODEL here is deliberately domain-neutral. A1's boat-storage cases
-- map onto it without special-casing, and so do the shapes other businesses need:
--
--   flat                fixed price                     ("spring commissioning")
--   per_unit            rate x quantity                 (batteries, PWCs, trips,
--                                                        months, seats, licences)
--   per_measure         rate x a measured dimension,    (per foot, per km,
--                       with an optional minimum         per sq ft, per hour)
--   per_unit_declining  unit 1 full, the rest at a      (engine 2+ at 75%,
--                       multiplier                       additional rooms, seats)
--   tiered_by_measure   flat price chosen by a band     (wrap removal <=26ft)
--
-- "lengthFt" and "engineCount" become `measure` and `quantity`. Nothing in the
-- schema knows what a boat is.
--
-- Surcharges are a separate concept: a per-measure uplift applied to lines that
-- opt in, selected by a variant the customer picks (hull type for A1; could be
-- material grade, rush tier, zone).
--
-- Catalogs are COMPANY-scoped, matching Stripe credentials, branding and voice
-- profiles. Two brands under one org price independently.

-- ─────────────────────────────────────────────────────────────────────────────
-- Services
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.service_catalog_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- Stable identifier used in quote line items and input snapshots. Renaming a
  -- label must never break an existing quote, so the KEY is what is referenced.
  service_key text not null,
  label text not null,
  description text,

  pricing_type text not null,
  rate_cents integer not null default 0,
  -- Floor for per_measure lines (a 12ft boat still pays the minimum).
  minimum_cents integer not null default 0,
  -- Singular noun for one unit, used in generated line descriptions.
  unit_label text,
  -- per_unit_declining: what units 2+ cost, as a fraction of the first.
  additional_unit_multiplier numeric(5, 4),
  -- tiered_by_measure: [{ "maxMeasure": 26, "rateCents": 15000 }, ...]
  -- A null maxMeasure is the open-ended top band.
  tiers jsonb,

  -- Sanity caps. Null means "use the engine default".
  max_quantity integer,
  max_measure numeric(10, 2),

  -- Whether a variant surcharge applies to this line.
  surcharge_eligible boolean not null default false,

  active boolean not null default true,
  sort_order integer not null default 0,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  unique (company_id, service_key),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

alter table public.service_catalog_items drop constraint if exists service_catalog_items_pricing_type_check;
alter table public.service_catalog_items add constraint service_catalog_items_pricing_type_check
  check (pricing_type in ('flat', 'per_unit', 'per_measure', 'per_unit_declining', 'tiered_by_measure'));

-- Money is integer cents everywhere, and negative prices are never intended.
alter table public.service_catalog_items drop constraint if exists service_catalog_items_amounts_check;
alter table public.service_catalog_items add constraint service_catalog_items_amounts_check
  check (rate_cents >= 0 and minimum_cents >= 0);

create index if not exists service_catalog_items_company_idx
  on public.service_catalog_items (company_id, active, sort_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- Bundles — a discount across a named set of services.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.service_catalog_bundles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  bundle_key text not null,
  label text not null,
  discount_pct numeric(5, 2) not null,
  -- Service keys in the bundle. A trailing '*' matches a family, so a bundle can
  -- say "whichever winterization they chose" without naming all three.
  service_keys text[] not null default '{}',

  active boolean not null default true,
  sort_order integer not null default 0,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  unique (company_id, bundle_key),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

alter table public.service_catalog_bundles drop constraint if exists service_catalog_bundles_discount_check;
alter table public.service_catalog_bundles add constraint service_catalog_bundles_discount_check
  check (discount_pct >= 0 and discount_pct < 100);

create index if not exists service_catalog_bundles_company_idx
  on public.service_catalog_bundles (company_id, active, sort_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- Variant surcharges — a per-measure uplift on lines that opt in.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.service_catalog_surcharges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  variant_key text not null,
  label text not null,
  per_measure_cents integer not null default 0,

  active boolean not null default true,

  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  unique (company_id, variant_key),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

create index if not exists service_catalog_surcharges_company_idx
  on public.service_catalog_surcharges (company_id, active);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ─────────────────────────────────────────────────────────────────────────────
drop trigger if exists service_catalog_items_set_updated_at on public.service_catalog_items;
create trigger service_catalog_items_set_updated_at
before update on public.service_catalog_items
for each row execute procedure public.touch_updated_at();

drop trigger if exists service_catalog_bundles_set_updated_at on public.service_catalog_bundles;
create trigger service_catalog_bundles_set_updated_at
before update on public.service_catalog_bundles
for each row execute procedure public.touch_updated_at();

drop trigger if exists service_catalog_surcharges_set_updated_at on public.service_catalog_surcharges;
create trigger service_catalog_surcharges_set_updated_at
before update on public.service_catalog_surcharges
for each row execute procedure public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: org members read and write their own catalog; the quote path reads via
-- the service role (a customer pricing a quote has no session).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.service_catalog_items enable row level security;
alter table public.service_catalog_bundles enable row level security;
alter table public.service_catalog_surcharges enable row level security;

drop policy if exists "service_catalog_items_org_members" on public.service_catalog_items;
create policy "service_catalog_items_org_members" on public.service_catalog_items
  for all using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

drop policy if exists "service_catalog_bundles_org_members" on public.service_catalog_bundles;
create policy "service_catalog_bundles_org_members" on public.service_catalog_bundles
  for all using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

drop policy if exists "service_catalog_surcharges_org_members" on public.service_catalog_surcharges;
create policy "service_catalog_surcharges_org_members" on public.service_catalog_surcharges
  for all using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
