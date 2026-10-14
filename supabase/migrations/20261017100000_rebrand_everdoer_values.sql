-- Everdoer rebrand, PR 2 (REBRAND_PLAN.md §5.1 + decision D7): stored values that still point at
-- EmpireVu / CrankLeads, and the per-company email sender column.
--
-- Run the read-only audit FIRST: supabase/tests/rebrand_values_audit.sql lists exactly which rows
-- and objects each step below touches.
--
--   1. backup         public.rebrand_values_backup (service role only, RLS on) keeps every value
--                     this migration changes, so the rollback restores exactly those values.
--   2. quote URLs     companies.quote_public_base_url whose host is EXACTLY app.crankleads.com or
--                     app.empirevu.com becomes https://app.everdoer.com (anything after the host is
--                     kept). Any other host is untouched, A1's quotes.a1marine*.ca included. Both
--                     hosts serve the same app, so links work before and after the legacy-host
--                     redirect is switched on.
--   3. waitlist       the DEFAULT of waitlist.source becomes 'everdoer.com'; existing rows keep theirs.
--   4. comments       table/column comments naming EmpireVu / CrankLeads now say Everdoer.
--   5. D7             new companies.email_from_address (nullable, one plain address). Service role
--                     only: no client grant (companies' client writes are a column allowlist since
--                     20261006170000, and this column is deliberately not on it), because the
--                     address must be on a domain the platform's Resend account covers. Nothing is
--                     set here: the app keeps the house org (A1) on OUTBOUND_FROM_EMAIL in code
--                     (outbound/company-sender.ts), so no tenant has to be guessed at.
--
-- NOT here: renaming the tenant named "CrankLeads" (done in the app), platform_brand values and
-- crankleads_* object renames (PR 7).
-- Re-runnable: every step skips what is already done, and the backup keeps the FIRST old value.
-- Rollback: supabase/rollback/20261017100000_rebrand_everdoer_values.down.sql
-- Tests:    scripts/sql-tests/zz_rebrand_values.test.sql

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Backup table
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.rebrand_values_backup (
  id bigserial primary key,
  step text not null check (step in ('quote_public_base_url', 'comment', 'default')),
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
-- 2. Quote link hosts: app.crankleads.com / app.empirevu.com → app.everdoer.com
-- ═════════════════════════════════════════════════════════════════════════════
-- The host must be exactly one of the two (app.crankleads.com.example.ca never matches).
insert into public.rebrand_values_backup (step, target_table, target_column, row_id, old_value, new_value)
select 'quote_public_base_url', 'companies', 'quote_public_base_url', c.id, c.quote_public_base_url,
       regexp_replace(c.quote_public_base_url, '^https://app\.(crankleads|empirevu)\.com', 'https://app.everdoer.com')
  from public.companies c
 where c.quote_public_base_url ~ '^https://app\.(crankleads|empirevu)\.com([/:?#]|$)'
on conflict do nothing;

update public.companies
   set quote_public_base_url = regexp_replace(quote_public_base_url, '^https://app\.(crankleads|empirevu)\.com', 'https://app.everdoer.com')
 where quote_public_base_url ~ '^https://app\.(crankleads|empirevu)\.com([/:?#]|$)';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. waitlist.source default (existing rows keep their value)
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
-- 4. Comments that name EmpireVu / CrankLeads
-- ═════════════════════════════════════════════════════════════════════════════
-- Each is replaced only while it still names an old brand; the old text is backed up first.
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
    if old_text is null or old_text = c.new_text or old_text !~ '(empirevu|crankleads)\.com|EmpireVu|CrankLeads' then
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
-- 5. D7: companies.email_from_address (service role only; nothing set here)
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

-- Not on the client allowlist (20261006170000 revoked table-level INSERT/UPDATE and granted columns
-- back one by one); these revokes are no-ops that keep it that way if a grant is ever added by mistake.
revoke insert (email_from_address), update (email_from_address) on public.companies from anon, authenticated;

comment on column public.companies.email_from_address is
  'D7: the From address for mail sent on this company''s behalf. Null = the house org keeps OUTBOUND_FROM_EMAIL, everyone else gets EVERDOER_DEFAULT_FROM_EMAIL (else OUTBOUND_FROM_EMAIL). Service role only: must be on a domain verified in the platform''s Resend account.';
