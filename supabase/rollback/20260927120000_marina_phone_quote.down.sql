-- Rollback for 20260927120000_marina_phone_quote.sql
alter table public.quotes drop column if exists deposit_flat_cents;
alter table public.companies drop column if exists quote_deposit_flat_cents;
alter table public.service_catalog_items drop column if exists additional_unit_rounding;
