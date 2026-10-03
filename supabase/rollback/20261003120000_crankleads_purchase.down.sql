-- Rollback for 20261003120000_crankleads_purchase.sql
-- Organizations already provisioned from a purchase are NOT removed — they are normal orgs.
-- Only the staging table and the tier column go. Take a copy of crankleads_purchases first if
-- any purchase is still in a non-terminal status (checkout_created / paid / provisioning /
-- failed): those rows are the only record of what the buyer submitted.

drop trigger if exists crankleads_purchases_set_updated_at on public.crankleads_purchases;
drop index if exists public.crankleads_purchases_status_idx;
drop index if exists public.crankleads_purchases_customer_idx;
drop table if exists public.crankleads_purchases;

alter table public.organizations drop constraint if exists organizations_crankleads_tier_check;
alter table public.organizations drop column if exists crankleads_tier;
