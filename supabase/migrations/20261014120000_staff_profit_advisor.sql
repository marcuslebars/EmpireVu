-- Phase 5 — Profit advisor (docs/ai-staff.md → "Profit advisor"): margins, pricing, cash forecast.
--
-- 1. price_changes          every price raise the monthly pricing check asked the owner about:
--                           the item, old → new price (+%), the numbers the owner saw (basis), the
--                           owner_approvals row, and what happened (proposed → applying → applied,
--                           or declined / expired / stale / failed). Applied rows are how the next
--                           check shows the effect, and how "once per item per 90 days" is kept.
--                           One open question per item (partial unique index). Margins come from
--                           pay rates, so owners/admins read; nobody else.
-- 2. profit_advisor_runs    the sweeps' claims: one weekly text per company per local day, one
--                           pricing check per company per month (unique company + kind + key).
--                           Service role only.
--
-- The cash forecast and job profit are computed on the fly from existing tables (nothing stored).
-- Settings live in companies.ai_settings.profit_advisor (no column needed). Prices change only
-- through the price_change approval's executor, server side, conditional on the price the owner saw.
--
-- Additive only and re-runnable. All writes go through the server (service role); nothing here is
-- client-writable (see 20261006170000).
-- Rollback: supabase/rollback/20261014120000_staff_profit_advisor.down.sql

-- ── 1. price_changes ─────────────────────────────────────────────────────────────────
create table if not exists public.price_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  -- set null, not cascade: the record of what was changed outlives a deleted price-list item.
  service_catalog_item_id uuid references public.service_catalog_items(id) on delete set null,
  item_label text not null check (length(btrim(item_label)) between 1 and 200),
  pricing_type text not null default 'flat',
  unit_label text,
  status text not null default 'proposed'
    check (status in ('proposed', 'applying', 'applied', 'declined', 'expired', 'stale', 'failed')),
  old_rate_cents integer not null check (old_rate_cents > 0),
  new_rate_cents integer not null,
  old_minimum_cents integer not null default 0 check (old_minimum_cents >= 0),
  new_minimum_cents integer not null default 0 check (new_minimum_cents >= 0),
  pct integer not null,
  -- {jobs, marginPct, companyMarginPct, quotes, winRatePct, windowDays}
  basis jsonb not null default '{}'::jsonb check (jsonb_typeof(basis) = 'object'),
  -- 'YYYY-MM' of the monthly check that asked
  run_key text,
  approval_id uuid references public.owner_approvals(id) on delete set null,
  decided_at timestamptz,
  applied_at timestamptz,
  result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Only ever a raise, and never more than +15% (the executor checks too; this is the backstop).
  constraint price_changes_raise_only check (new_rate_cents > old_rate_cents and new_rate_cents <= floor(old_rate_cents * 1.15)),
  constraint price_changes_minimum_raise_only check (new_minimum_cents >= old_minimum_cents and new_minimum_cents <= greatest(old_minimum_cents, floor(old_minimum_cents * 1.15))),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists price_changes_company_idx on public.price_changes (organization_id, company_id, created_at desc);
create unique index if not exists price_changes_approval_idx on public.price_changes (approval_id) where approval_id is not null;
-- One open question per price-list item.
create unique index if not exists price_changes_one_open_per_item_idx on public.price_changes (service_catalog_item_id)
  where status in ('proposed', 'applying') and service_catalog_item_id is not null;

-- ── 2. profit_advisor_runs (the sweeps' claims) ───────────────────────────────────────────
create table if not exists public.profit_advisor_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  kind text not null check (kind in ('weekly', 'pricing')),
  -- weekly: the local date; pricing: 'YYYY-MM'
  run_key text not null check (length(run_key) between 7 and 10),
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'skipped', 'failed')),
  attempts integer not null default 1 check (attempts >= 1),
  body text,
  detail jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, kind, run_key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists profit_advisor_runs_company_idx on public.profit_advisor_runs (organization_id, company_id, kind, run_key desc);

-- ── RLS + grants: owners/admins read price changes; runs are service role only; nobody writes ──
alter table public.price_changes enable row level security;
alter table public.profit_advisor_runs enable row level security;

drop policy if exists "price_changes_select" on public.price_changes;
create policy "price_changes_select" on public.price_changes
  for select using (public.is_organization_admin(organization_id));

revoke insert, update, delete on public.price_changes, public.profit_advisor_runs from anon, authenticated;
revoke select on public.price_changes, public.profit_advisor_runs from anon;
revoke select on public.profit_advisor_runs from authenticated;
grant select on public.price_changes to authenticated;
grant all on public.price_changes, public.profit_advisor_runs to service_role;

drop trigger if exists price_changes_set_updated_at on public.price_changes;
create trigger price_changes_set_updated_at before update on public.price_changes
  for each row execute procedure public.touch_updated_at();
drop trigger if exists profit_advisor_runs_set_updated_at on public.profit_advisor_runs;
create trigger profit_advisor_runs_set_updated_at before update on public.profit_advisor_runs
  for each row execute procedure public.touch_updated_at();

comment on table public.price_changes is 'Profit advisor: price raises the monthly pricing check asked about (and what the owner decided). Owners/admins read; service role writes. Only a raise, at most +15%.';
comment on table public.profit_advisor_runs is 'Profit advisor: the weekly money text and monthly pricing check claims (one per company per day / month). Service role only.';
