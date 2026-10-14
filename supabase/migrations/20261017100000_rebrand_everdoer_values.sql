-- Everdoer rebrand, PR 2 (REBRAND_PLAN.md §5.1 + decision D7): the stored VALUES that still say
-- EmpireVu / CrankLeads, and the per-company email sender.
--
-- Run the read-only audit FIRST: supabase/tests/rebrand_values_audit.sql (same settings block).
-- It lists exactly which rows each step below touches.
--
--   1. backup         public.rebrand_values_backup (service role only, RLS on) keeps every value
--                     this migration changes, so the rollback restores exactly those values.
--   2. names          organizations / companies whose name is EXACTLY 'CrankLeads' or 'EmpireVu'
--                     (case-sensitive, no trimming, no LIKE) become 'Everdoer'. Never an A1 company
--                     or the A1 org; slugs are untouched (routing keys).
--   3. quote URLs     companies.quote_public_base_url on https://app.crankleads.com or
--                     https://app.empirevu.com becomes https://app.everdoer.com (any path kept).
--                     Every other value is untouched, A1's quotes.a1marine*.ca included, and A1
--                     companies are skipped whatever their value. Both hosts serve the same app,
--                     so links work before and after the legacy-host redirect is switched on.
--   4. waitlist       the DEFAULT of waitlist.source becomes 'everdoer.com'; existing rows keep theirs.
--   5. comments       table/column comments naming EmpireVu / CrankLeads now say Everdoer.
--   6. D7             new companies.email_from_address (nullable, must look like one address).
--                     Service role only: no client grant (companies' client writes are a column
--                     allowlist since 20261006170000, and this column is deliberately not on it),
--                     because the address must be on a domain the platform's Resend account
--                     covers. The app sends a company's mail from it, else
--                     EVERDOER_DEFAULT_FROM_EMAIL, else OUTBOUND_FROM_EMAIL.
--   7. A1 sender      the A1 companies get email_from_address = the A1 sender below, so A1's
--                     customer mail keeps its exact From address when the platform default moves
--                     to @everdoer.com. A value already set is never overwritten.
--
-- How the A1 companies are identified (any one is enough; the audit shows which matched):
--   (a) the company belongs to the org the A1 lead intake is pinned to: organizations.slug =
--       a1_org_slug (Railway LEAD_INTAKE_ORG_SLUG, default 'a1-group'; routing.ts sends
--       a1marinecare / a1marinestorage / a1coatings / boatnames to companies a1-marine-care,
--       a1-marine-storage, a1-coatings, a1-boatnames in that org);
--   (b) its brand_reply_email is on an A1 domain (a1_domains);
--   (c) its quote_public_base_url is on an A1 domain (quotes.a1marinecare.ca, …).
-- Over-matching only keeps a company on today's sender; under-matching would move A1 customer
-- mail to @everdoer.com, so the rule errs wide.
--
-- NOT here: platform_brand values and crankleads_* object renames (PR 7).
-- Re-runnable: every step skips rows already done, and the backup keeps the FIRST old value.
-- Rollback: supabase/rollback/20261017100000_rebrand_everdoer_values.down.sql
-- Tests:    scripts/sql-tests/zz_rebrand_values.test.sql

begin;

-- ═════════════════════════════════════════════════════════════════════════════
-- SETTINGS: check these before running (the audit uses the same block).
-- ═════════════════════════════════════════════════════════════════════════════
create temporary table _rebrand_settings on commit drop as
select
  -- The A1 companies' sender. MUST equal the bare address in Railway → EmpireVu (web) →
  -- OUTBOUND_FROM_EMAIL today (docs say quotes@a1marinestorage.ca). If that variable is
  -- "Name <addr>", put only addr here.
  'quotes@a1marinestorage.ca'::text as a1_from,
  -- The A1 org: Railway LEAD_INTAKE_ORG_SLUG (unset = 'a1-group').
  'a1-group'::text as a1_org_slug,
  -- A1's own email / quote-link domains.
  array['a1marinecare.ca', 'a1marinestorage.ca']::text[] as a1_domains;

do $$
declare
  s record;
begin
  select * into s from _rebrand_settings;
  if s.a1_from is null or s.a1_from !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$' then
    raise exception 'a1_from must be one bare email address (got %)', s.a1_from;
  end if;
  if not exists (select 1 from public.organizations where slug = s.a1_org_slug) then
    raise notice 'No organization has slug % — A1 companies are matched by domain only. Check LEAD_INTAKE_ORG_SLUG.', s.a1_org_slug;
  end if;
end $$;

-- The A1 companies, fixed before anything is renamed.
create temporary table _rebrand_a1_companies on commit drop as
select c.id
  from public.companies c
  join public.organizations o on o.id = c.organization_id
  cross join _rebrand_settings s
 where o.slug = s.a1_org_slug
    or lower(split_part(coalesce(c.brand_reply_email, ''), '@', 2)) = any (s.a1_domains)
    or exists (
      select 1 from unnest(s.a1_domains) d
       where c.quote_public_base_url ~* ('^https://([a-z0-9-]+\.)*' || replace(d, '.', '\.') || '(/|$)')
    );

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Backup table
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.rebrand_values_backup (
  id bigserial primary key,
  step text not null check (step in ('name', 'quote_public_base_url', 'email_from_address', 'comment', 'default')),
  target_table text not null,
  target_column text,            -- null: a table comment
  row_id uuid,                   -- null: a comment or default
  old_value text,                -- null: the value was null (or there was no comment)
  new_value text,
  backed_up_at timestamptz not null default now(),
  unique nulls not distinct (step, target_table, target_column, row_id)
);

alter table public.rebrand_values_backup enable row level security;
revoke all on public.rebrand_values_backup from anon, authenticated;
revoke all on sequence public.rebrand_values_backup_id_seq from anon, authenticated;
grant all on public.rebrand_values_backup to service_role;
grant usage, select on sequence public.rebrand_values_backup_id_seq to service_role;

comment on table public.rebrand_values_backup is
  'Everdoer rebrand (20261017100000): every value the values migration changed, for its rollback. Service role only. Dropped by the rollback.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Names: exactly 'CrankLeads' / 'EmpireVu' → 'Everdoer'
-- ═════════════════════════════════════════════════════════════════════════════
insert into public.rebrand_values_backup (step, target_table, target_column, row_id, old_value, new_value)
select 'name', 'organizations', 'name', o.id, o.name, 'Everdoer'
  from public.organizations o, _rebrand_settings s
 where o.name in ('CrankLeads', 'EmpireVu')
   and o.slug <> s.a1_org_slug
on conflict do nothing;

update public.organizations o
   set name = 'Everdoer'
  from _rebrand_settings s
 where o.name in ('CrankLeads', 'EmpireVu')
   and o.slug <> s.a1_org_slug;

insert into public.rebrand_values_backup (step, target_table, target_column, row_id, old_value, new_value)
select 'name', 'companies', 'name', c.id, c.name, 'Everdoer'
  from public.companies c
 where c.name in ('CrankLeads', 'EmpireVu')
   and c.id not in (select id from _rebrand_a1_companies)
on conflict do nothing;

update public.companies c
   set name = 'Everdoer'
 where c.name in ('CrankLeads', 'EmpireVu')
   and c.id not in (select id from _rebrand_a1_companies);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Quote link hosts: app.crankleads.com / app.empirevu.com → app.everdoer.com
-- ═════════════════════════════════════════════════════════════════════════════
-- The host must be exactly one of the two (so app.crankleads.com.example.ca never matches);
-- anything after it (port, path, query) is kept.
insert into public.rebrand_values_backup (step, target_table, target_column, row_id, old_value, new_value)
select 'quote_public_base_url', 'companies', 'quote_public_base_url', c.id, c.quote_public_base_url,
       regexp_replace(c.quote_public_base_url, '^https://app\.(crankleads|empirevu)\.com', 'https://app.everdoer.com')
  from public.companies c
 where c.quote_public_base_url ~ '^https://app\.(crankleads|empirevu)\.com([/:?#]|$)'
   and c.id not in (select id from _rebrand_a1_companies)
on conflict do nothing;

update public.companies c
   set quote_public_base_url = regexp_replace(c.quote_public_base_url, '^https://app\.(crankleads|empirevu)\.com', 'https://app.everdoer.com')
 where c.quote_public_base_url ~ '^https://app\.(crankleads|empirevu)\.com([/:?#]|$)'
   and c.id not in (select id from _rebrand_a1_companies);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. waitlist.source default (existing rows keep their value)
-- ═════════════════════════════════════════════════════════════════════════════
insert into public.rebrand_values_backup (step, target_table, target_column, old_value, new_value)
select 'default', 'waitlist', 'source', pg_get_expr(d.adbin, d.adrelid), '''everdoer.com''::text'
  from pg_attrdef d
  join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
 where d.adrelid = 'public.waitlist'::regclass and a.attname = 'source'
   and pg_get_expr(d.adbin, d.adrelid) <> '''everdoer.com''::text'
on conflict do nothing;

alter table public.waitlist alter column source set default 'everdoer.com';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Comments that name EmpireVu / CrankLeads
-- ═════════════════════════════════════════════════════════════════════════════
-- Each is replaced only while it still names an old brand, and the old text is backed up first.
-- platform_brand's comment keeps the stored values 'empirevu' / 'crankleads' (renamed in PR 7).
do $$
declare
  c record;
  old_text text;
begin
  for c in
    select * from (values
      ('dfy_progress', null::text,
       'Done-for-you switch-on progress per Everdoer done-for-you company (services/dfy/orchestrator.ts). Service role writes only.'),
      ('organizations', 'platform_brand',
       'Which Everdoer product line this org is on: empirevu = standard (default), crankleads = done-for-you (bought on everdoer.com). Both show as Everdoer; the stored values are renamed in a later migration. Not an access control.'),
      ('waitlist', null::text,
       'Early-access signups from the Everdoer marketing site (service-role writes only). source is the site the signup came from.')
    ) as t(tbl, col, new_text)
  loop
    if to_regclass('public.' || c.tbl) is null then
      continue;
    end if;
    if c.col is null then
      old_text := obj_description(('public.' || c.tbl)::regclass, 'pg_class');
    else
      old_text := col_description(('public.' || c.tbl)::regclass,
        (select attnum from pg_attribute where attrelid = ('public.' || c.tbl)::regclass and attname = c.col and not attisdropped));
    end if;
    if old_text is null or old_text !~* '(empirevu|crankleads)\.com|EmpireVu|CrankLeads' or old_text = c.new_text then
      continue;
    end if;
    insert into public.rebrand_values_backup (step, target_table, target_column, old_value, new_value)
    values ('comment', c.tbl, c.col, old_text, c.new_text)
    on conflict do nothing;
    if c.col is null then
      execute format('comment on table public.%I is %L', c.tbl, c.new_text);
    else
      execute format('comment on column public.%I.%I is %L', c.tbl, c.col, c.new_text);
    end if;
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. D7: companies.email_from_address (service role only)
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.companies add column if not exists email_from_address text;

alter table public.companies drop constraint if exists companies_email_from_address_check;
alter table public.companies add constraint companies_email_from_address_check check (
  email_from_address is null
  or (
    length(email_from_address) <= 254
    and email_from_address ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$'
  )
);

-- Not on the client allowlist (20261006170000 revoked table-level INSERT/UPDATE and granted
-- columns back one by one); these revokes are no-ops that keep it that way if a column grant
-- is ever added by mistake. Reading it is fine (it's the address on every email the company sends).
revoke insert (email_from_address), update (email_from_address) on public.companies from anon, authenticated;

comment on column public.companies.email_from_address is
  'D7: the From address for mail sent on this company''s behalf. Null = the platform default (EVERDOER_DEFAULT_FROM_EMAIL, else OUTBOUND_FROM_EMAIL). Service role only: must be on a domain verified in the platform''s Resend account.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. The A1 companies keep their current sender
-- ═════════════════════════════════════════════════════════════════════════════
insert into public.rebrand_values_backup (step, target_table, target_column, row_id, old_value, new_value)
select 'email_from_address', 'companies', 'email_from_address', c.id, null, s.a1_from
  from public.companies c, _rebrand_settings s
 where c.id in (select id from _rebrand_a1_companies)
   and c.email_from_address is null
on conflict do nothing;

update public.companies c
   set email_from_address = s.a1_from
  from _rebrand_settings s
 where c.id in (select id from _rebrand_a1_companies)
   and c.email_from_address is null;

commit;
