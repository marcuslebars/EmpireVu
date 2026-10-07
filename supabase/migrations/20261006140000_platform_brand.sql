-- Per-account platform brand (docs/crankleads-branding.md).
--
-- The codebase and house tenants stay EmpireVu; an org that bought CrankLeads sees
-- CrankLeads everywhere (logo, tab title, favicon, theme, emails, links to
-- app.crankleads.com). This column is the switch. 'empirevu' is the default for every
-- existing and self-serve org; CrankLeads provisioning writes 'crankleads'
-- (src/server/services/crankleads/provision.ts → organizations.ts createOrganization).
--
-- Additive only. Rollback: supabase/rollback/20261006140000_platform_brand.down.sql.

alter table public.organizations
  add column if not exists platform_brand text not null default 'empirevu';

alter table public.organizations
  drop constraint if exists organizations_platform_brand_check;
alter table public.organizations
  add constraint organizations_platform_brand_check
    check (platform_brand in ('empirevu', 'crankleads'));

-- Backfill: every org provisioned from a CrankLeads purchase so far.
update public.organizations
   set platform_brand = 'crankleads'
 where crankleads_tier is not null
   and platform_brand <> 'crankleads';

comment on column public.organizations.platform_brand is
  'Which product brand this org''s own people see: empirevu (default) or crankleads (bought on crankleads.com). Not an access control.';
