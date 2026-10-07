-- Rollback for 20261006140000_platform_brand.sql
-- Safe at any time: CrankLeads orgs are still identifiable by organizations.crankleads_tier,
-- and the app falls back to that (src/lib/platform-brand.ts brandForOrg) when the column is
-- absent. Deploy the app revert first if the app code selects platform_brand explicitly.

alter table public.organizations drop constraint if exists organizations_platform_brand_check;
alter table public.organizations drop column if exists platform_brand;
