-- Marina's phone quote moves into EmpireVu (the A1 Marine Care site is retiring its own
-- copy). Two pricing rules the Care site already quotes on every call need a home in the
-- tenant model, and nothing here changes a price for any existing tenant.
--
-- 1. service_catalog_items.additional_unit_rounding
--    per_unit_declining lines ("engine 2+ at 75%") round the additional-unit price to the
--    nearest whole DOLLAR — inherited from @a1/pricing-engine, pinned by the golden
--    fixtures, and still the default. The Care site's shrink-wrap calculator rounds to the
--    CENT (twin inboards: $445 + $333.75 = $778.75, not $779), and callers have been quoted
--    that way all season. 'cent' lets a catalog item keep its tenant's existing prices.
--
-- 2. companies.quote_deposit_flat_cents / quotes.deposit_flat_cents
--    Deposits are a percentage of the tax-inclusive total (QUOTE_DEPOSIT_BPS, 25%). Some
--    tenants take a fixed amount instead — A1 Marine Care holds a date with $250 that comes
--    off the final invoice. The company column is the policy; the quote column freezes the
--    policy that priced that quote, so a customer toggling options on the hosted page (or a
--    later policy change) re-prices with the rule the quote was issued under.
--    NULL = percentage, as today.

alter table public.service_catalog_items
  add column if not exists additional_unit_rounding text not null default 'dollar';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'service_catalog_items_additional_unit_rounding_check'
  ) then
    alter table public.service_catalog_items
      add constraint service_catalog_items_additional_unit_rounding_check
      check (additional_unit_rounding in ('dollar', 'cent'));
  end if;
end $$;

alter table public.companies
  add column if not exists quote_deposit_flat_cents integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'companies_quote_deposit_flat_cents_check'
  ) then
    alter table public.companies
      add constraint companies_quote_deposit_flat_cents_check
      check (quote_deposit_flat_cents is null or quote_deposit_flat_cents > 0);
  end if;
end $$;

alter table public.quotes
  add column if not exists deposit_flat_cents integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quotes_deposit_flat_cents_check'
  ) then
    alter table public.quotes
      add constraint quotes_deposit_flat_cents_check
      check (deposit_flat_cents is null or deposit_flat_cents > 0);
  end if;
end $$;

comment on column public.service_catalog_items.additional_unit_rounding is
  'per_unit_declining: round each additional unit to the nearest dollar (default, engine behaviour) or cent.';
comment on column public.companies.quote_deposit_flat_cents is
  'Fixed booking deposit in cents (capped at the quote total). NULL = QUOTE_DEPOSIT_BPS percentage.';
comment on column public.quotes.deposit_flat_cents is
  'The fixed-deposit policy frozen at pricing time. NULL = percentage (deposit_rate_bps).';
