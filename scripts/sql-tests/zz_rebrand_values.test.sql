-- Tests for 20261017100000_rebrand_everdoer_values.sql (Everdoer rebrand, PR 2) and its rollback.
--   • privileges: companies.email_from_address is not client-writable (owner/admin/member/anon),
--     the service role can set it, the check refuses a non-address; rebrand_values_backup is RLS-on
--     and service-role only;
--   • names: only EXACT 'CrankLeads' / 'EmpireVu' orgs and companies are renamed, never A1's;
--   • quote links: only app.crankleads.com / app.empirevu.com are rewritten, A1 excluded
--     (quotes.a1marine*.ca and an A1 company on a legacy host alike), look-alike hosts untouched;
--   • waitlist.source default, comments, the A1 sender (by org slug, reply-email domain, quote host),
--     a sender already set is never overwritten;
--   • running it twice changes nothing;
--   • the rollback restores every value, comment and default, drops the column and the backup;
--   • migrate → rollback → migrate again works.
-- run.sh has already applied every migration (this one included) to an empty database, so this
-- file first rolls it back, loads fixtures into the pre-migration schema, then re-applies it.
\set ON_ERROR_STOP on
set client_min_messages = warning;
reset role;

\i supabase/rollback/20261017100000_rebrand_everdoer_values.down.sql

-- ── fixtures (pre-migration schema) ──────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e7d01', 'owner@crankleads.test'),
  ('00000000-0000-0000-0000-0000000e7d02', 'owner@a1.test'),
  ('00000000-0000-0000-0000-0000000e7d03', 'owner@blairs.test')
on conflict do nothing;

insert into public.organizations (id, name, slug, plan, created_by) values
  ('00000000-0000-0000-0000-0000000e7a01', 'CrankLeads', 'crankleads-house', 'internal', '00000000-0000-0000-0000-0000000e7d01'),
  ('00000000-0000-0000-0000-0000000e7a02', 'A1 Group', 'a1-group', 'internal', '00000000-0000-0000-0000-0000000e7d02'),
  ('00000000-0000-0000-0000-0000000e7a03', 'Blair''s', 'blairs', 'launch', '00000000-0000-0000-0000-0000000e7d03'),
  ('00000000-0000-0000-0000-0000000e7a04', 'CrankLeads Inc', 'crankleads-inc', 'launch', null),
  ('00000000-0000-0000-0000-0000000e7a05', 'empirevu', 'lowercase-empirevu', 'launch', null),
  ('00000000-0000-0000-0000-0000000e7a06', 'EmpireVu', 'empirevu-demo-like', 'launch', null)
on conflict do nothing;

insert into public.organization_memberships (organization_id, profile_id, role) values
  ('00000000-0000-0000-0000-0000000e7a01', '00000000-0000-0000-0000-0000000e7d01', 'owner'),
  ('00000000-0000-0000-0000-0000000e7a02', '00000000-0000-0000-0000-0000000e7d02', 'owner'),
  ('00000000-0000-0000-0000-0000000e7a03', '00000000-0000-0000-0000-0000000e7d03', 'owner')
on conflict do nothing;

insert into public.companies (id, organization_id, name, slug, quote_public_base_url, brand_reply_email, brand_from_name) values
  -- the CrankLeads tenant: renamed, link host moved
  ('00000000-0000-0000-0000-0000000e7c01', '00000000-0000-0000-0000-0000000e7a01', 'CrankLeads', 'crankleads', 'https://app.crankleads.com', null, 'CrankLeads'),
  -- A1 (org slug a1-group): never renamed or re-hosted, sender pinned
  ('00000000-0000-0000-0000-0000000e7c02', '00000000-0000-0000-0000-0000000e7a02', 'A1 Marine Care', 'a1-marine-care', 'https://quotes.a1marinecare.ca', 'office@a1marinecare.ca', 'A1 Marine Care'),
  ('00000000-0000-0000-0000-0000000e7c03', '00000000-0000-0000-0000-0000000e7a02', 'A1 Marine Storage', 'a1-marine-storage', 'https://quotes.a1marinestorage.ca', null, null),
  ('00000000-0000-0000-0000-0000000e7c04', '00000000-0000-0000-0000-0000000e7a02', 'boatnames.ca', 'a1-boatnames', null, null, null),
  ('00000000-0000-0000-0000-0000000e7c05', '00000000-0000-0000-0000-0000000e7a02', 'EmpireVu', 'a1-legacy', 'https://app.empirevu.com', null, null),
  -- Blair's: name untouched, legacy link host moved, no sender
  ('00000000-0000-0000-0000-0000000e7c06', '00000000-0000-0000-0000-0000000e7a03', 'Blair''s Marine', 'blairs-marine', 'https://app.empirevu.com', 'hello@blairs.test', 'Blair''s'),
  -- near misses: not exact names, look-alike host
  ('00000000-0000-0000-0000-0000000e7c07', '00000000-0000-0000-0000-0000000e7a03', 'Empirevu', 'case', 'https://app.crankleads.com.example.ca', null, null),
  ('00000000-0000-0000-0000-0000000e7c08', '00000000-0000-0000-0000-0000000e7a03', ' CrankLeads', 'space', 'https://app.empirevu.co', null, null),
  ('00000000-0000-0000-0000-0000000e7c09', '00000000-0000-0000-0000-0000000e7a03', 'CrankLeads Roofing', 'roofing', 'https://xapp.empirevu.com', null, null),
  -- an A1 company found only by its reply-email domain (another org)
  ('00000000-0000-0000-0000-0000000e7c0a', '00000000-0000-0000-0000-0000000e7a04', 'A1 Coatings', 'a1-coatings', null, 'Paint@A1MarineCare.ca', null)
on conflict do nothing;

insert into public.waitlist (email) values ('early@example.com');

-- The originals, to compare with after the rollback.
create temporary table rv_before as
select 'org' as kind, id, name, null::text as url from public.organizations where id::text like '00000000-0000-0000-0000-0000000e7a%'
union all
select 'company', id, name, quote_public_base_url from public.companies where id::text like '00000000-0000-0000-0000-0000000e7c%';
create temporary table rv_meta_before as
select obj_description('public.waitlist'::regclass) as waitlist_comment,
       obj_description('public.dfy_progress'::regclass) as dfy_comment,
       col_description('public.organizations'::regclass, (select attnum from pg_attribute where attrelid = 'public.organizations'::regclass and attname = 'platform_brand')) as brand_comment,
       (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'waitlist' and column_name = 'source') as source_default;

-- ── migrate ──────────────────────────────────────────────────────────────────
\i supabase/migrations/20261017100000_rebrand_everdoer_values.sql

set client_min_messages = notice;
do $$
declare
  v text;
begin
  raise notice '== rebrand values: names';
  if (select name from public.organizations where id = '00000000-0000-0000-0000-0000000e7a01') <> 'Everdoer' then raise exception 'FAIL CrankLeads org not renamed'; end if;
  if (select name from public.organizations where id = '00000000-0000-0000-0000-0000000e7a06') <> 'Everdoer' then raise exception 'FAIL EmpireVu org not renamed'; end if;
  if (select slug from public.organizations where id = '00000000-0000-0000-0000-0000000e7a01') <> 'crankleads-house' then raise exception 'FAIL slug changed'; end if;
  if (select name from public.companies where id = '00000000-0000-0000-0000-0000000e7c01') <> 'Everdoer' then raise exception 'FAIL CrankLeads company not renamed'; end if;
  if (select slug from public.companies where id = '00000000-0000-0000-0000-0000000e7c01') <> 'crankleads' then raise exception 'FAIL company slug changed'; end if;
  if (select brand_from_name from public.companies where id = '00000000-0000-0000-0000-0000000e7c01') <> 'CrankLeads' then raise exception 'FAIL brand_from_name changed (tenant branding)'; end if;
  -- only exact matches
  if (select count(*) from public.organizations where name = 'Everdoer') <> 2 then raise exception 'FAIL expected exactly 2 orgs renamed'; end if;
  if (select count(*) from public.companies where name = 'Everdoer') <> 1 then raise exception 'FAIL expected exactly 1 company renamed'; end if;
  if (select name from public.organizations where id = '00000000-0000-0000-0000-0000000e7a04') <> 'CrankLeads Inc' then raise exception 'FAIL near-miss org renamed'; end if;
  if (select name from public.organizations where id = '00000000-0000-0000-0000-0000000e7a05') <> 'empirevu' then raise exception 'FAIL lowercase org renamed'; end if;
  if (select name from public.companies where id = '00000000-0000-0000-0000-0000000e7c07') <> 'Empirevu' then raise exception 'FAIL wrong-case company renamed'; end if;
  if (select name from public.companies where id = '00000000-0000-0000-0000-0000000e7c08') <> ' CrankLeads' then raise exception 'FAIL padded company renamed'; end if;
  if (select name from public.companies where id = '00000000-0000-0000-0000-0000000e7c09') <> 'CrankLeads Roofing' then raise exception 'FAIL near-miss company renamed'; end if;
  -- never A1 or Blair's
  if (select name from public.companies where id = '00000000-0000-0000-0000-0000000e7c05') <> 'EmpireVu' then raise exception 'FAIL A1 company named EmpireVu was renamed'; end if;
  if (select name from public.organizations where id = '00000000-0000-0000-0000-0000000e7a02') <> 'A1 Group' then raise exception 'FAIL A1 org touched'; end if;
  if (select name from public.organizations where id = '00000000-0000-0000-0000-0000000e7a03') <> 'Blair''s' then raise exception 'FAIL Blair''s org touched'; end if;
  if (select name from public.companies where id = '00000000-0000-0000-0000-0000000e7c06') <> 'Blair''s Marine' then raise exception 'FAIL Blair''s company touched'; end if;
  raise notice 'ok   only exact CrankLeads / EmpireVu names renamed; A1, Blair''s and near misses untouched';

  raise notice '== rebrand values: quote link hosts';
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c01') <> 'https://app.everdoer.com' then raise exception 'FAIL crankleads host not moved'; end if;
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c06') <> 'https://app.everdoer.com' then raise exception 'FAIL empirevu host not moved'; end if;
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c02') <> 'https://quotes.a1marinecare.ca' then raise exception 'FAIL A1 Care quote host touched'; end if;
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c03') <> 'https://quotes.a1marinestorage.ca' then raise exception 'FAIL A1 Storage quote host touched'; end if;
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c05') <> 'https://app.empirevu.com' then raise exception 'FAIL A1 company on a legacy host was moved'; end if;
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c07') <> 'https://app.crankleads.com.example.ca' then raise exception 'FAIL look-alike host moved'; end if;
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c08') <> 'https://app.empirevu.co' then raise exception 'FAIL other TLD moved'; end if;
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c09') <> 'https://xapp.empirevu.com' then raise exception 'FAIL other subdomain moved'; end if;
  raise notice 'ok   app.crankleads.com / app.empirevu.com → app.everdoer.com; A1 and look-alikes untouched';

  raise notice '== rebrand values: default + comments';
  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'waitlist' and column_name = 'source') <> '''everdoer.com''::text' then raise exception 'FAIL waitlist default'; end if;
  if (select source from public.waitlist where email = 'early@example.com') <> 'empirevu.com' then raise exception 'FAIL existing waitlist row changed'; end if;
  insert into public.waitlist (email) values ('new@example.com');
  if (select source from public.waitlist where email = 'new@example.com') <> 'everdoer.com' then raise exception 'FAIL new waitlist row default'; end if;
  if obj_description('public.waitlist'::regclass) ~ 'EmpireVu|CrankLeads|empirevu\.com|crankleads\.com' then raise exception 'FAIL waitlist comment'; end if;
  if obj_description('public.dfy_progress'::regclass) ~ 'EmpireVu|CrankLeads' then raise exception 'FAIL dfy_progress comment'; end if;
  v := col_description('public.organizations'::regclass, (select attnum from pg_attribute where attrelid = 'public.organizations'::regclass and attname = 'platform_brand'));
  if v ~ 'EmpireVu|CrankLeads|crankleads\.com' or v !~ 'Everdoer' then raise exception 'FAIL platform_brand comment: %', v; end if;
  raise notice 'ok   waitlist.source default everdoer.com (old rows kept); comments say Everdoer';

  raise notice '== rebrand values: A1 sender';
  if (select count(*) from public.companies where email_from_address = 'quotes@a1marinestorage.ca') <> 5 then
    raise exception 'FAIL expected 5 A1 companies with the A1 sender, got %', (select count(*) from public.companies where email_from_address = 'quotes@a1marinestorage.ca');
  end if;
  if exists (select 1 from public.companies where email_from_address is not null and id not in (
      '00000000-0000-0000-0000-0000000e7c02', '00000000-0000-0000-0000-0000000e7c03', '00000000-0000-0000-0000-0000000e7c04',
      '00000000-0000-0000-0000-0000000e7c05', '00000000-0000-0000-0000-0000000e7c0a')) then
    raise exception 'FAIL a non-A1 company got a sender';
  end if;
  raise notice 'ok   A1 companies (org slug, reply-email domain) pinned to the A1 sender; nobody else';
end $$;

-- ── privileges ───────────────────────────────────────────────────────────────
do $$
declare
  r text;
  p text;
begin
  raise notice '== rebrand values: privileges';
  foreach r in array array['anon', 'authenticated'] loop
    if has_column_privilege(r, 'public.companies', 'email_from_address', 'UPDATE') then raise exception 'FAIL % may UPDATE companies.email_from_address', r; end if;
    if has_column_privilege(r, 'public.companies', 'email_from_address', 'INSERT') then raise exception 'FAIL % may INSERT companies.email_from_address', r; end if;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(r, 'public.rebrand_values_backup', p) then raise exception 'FAIL % has % on rebrand_values_backup', r, p; end if;
    end loop;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.rebrand_values_backup'::regclass) then raise exception 'FAIL rebrand_values_backup RLS off'; end if;
  if not has_table_privilege('service_role', 'public.rebrand_values_backup', 'SELECT') then raise exception 'FAIL service_role cannot read the backup'; end if;
  if not has_column_privilege('service_role', 'public.companies', 'email_from_address', 'UPDATE') then raise exception 'FAIL service_role cannot set email_from_address'; end if;
  if not has_column_privilege('authenticated', 'public.companies', 'brand_reply_email', 'UPDATE') then raise exception 'FAIL authenticated lost brand_reply_email'; end if;
  begin
    update public.companies set email_from_address = 'Evil <x@y.com>' where id = '00000000-0000-0000-0000-0000000e7c06';
    raise exception 'FAIL check accepted a display-name address';
  exception when check_violation then null;
  end;
  begin
    update public.companies set email_from_address = 'not-an-email' where id = '00000000-0000-0000-0000-0000000e7c06';
    raise exception 'FAIL check accepted a non-address';
  exception when check_violation then null;
  end;
  raise notice 'ok   email_from_address and the backup are service-role only; the check refuses non-addresses';
end $$;

-- As PostgREST would: the Blair's owner, then anon.
set role authenticated;
set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e7d03';
call sqltest.expect_denied('owner sets companies.email_from_address on their own company',
  $$update public.companies set email_from_address = 'ceo@bigbank.com' where id = '00000000-0000-0000-0000-0000000e7c06'$$);
call sqltest.expect_denied('owner creates a company with email_from_address',
  $$insert into public.companies (organization_id, name, slug, email_from_address) values ('00000000-0000-0000-0000-0000000e7a03', 'X', 'x-sender', 'ceo@bigbank.com')$$);
call sqltest.expect_denied('owner reads rebrand_values_backup', $$select count(*) from public.rebrand_values_backup$$);
call sqltest.expect_rows('owner still edits brand_reply_email',
  $$update public.companies set brand_reply_email = 'hello@blairs.test' where id = '00000000-0000-0000-0000-0000000e7c06'$$, 1);
reset role;
set role anon;
call sqltest.expect_denied('anon sets companies.email_from_address', $$update public.companies set email_from_address = 'a@b.co'$$);
call sqltest.expect_denied('anon reads rebrand_values_backup', $$select count(*) from public.rebrand_values_backup$$);
reset role;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;
set role service_role;
call sqltest.expect_rows('service role sets email_from_address',
  $$update public.companies set email_from_address = 'quotes@blairs.test' where id = '00000000-0000-0000-0000-0000000e7c06'$$, 1);
call sqltest.expect_rows('service role clears it again',
  $$update public.companies set email_from_address = null where id = '00000000-0000-0000-0000-0000000e7c06'$$, 1);
reset role;

-- ── idempotent: a second run changes nothing, and keeps a sender set by hand ───
update public.companies set email_from_address = 'care@a1marinecare.ca' where id = '00000000-0000-0000-0000-0000000e7c02';
create temporary table rv_after1 as
select id, name, quote_public_base_url as url, email_from_address from public.companies where id::text like '00000000-0000-0000-0000-0000000e7c%'
union all
select id, name, null, null from public.organizations where id::text like '00000000-0000-0000-0000-0000000e7a%';
create temporary table rv_backup1 as select step, target_table, target_column, row_id, old_value, new_value from public.rebrand_values_backup;
create temporary table rv_meta1 as
select obj_description('public.waitlist'::regclass) as w, obj_description('public.dfy_progress'::regclass) as d,
       col_description('public.organizations'::regclass, (select attnum from pg_attribute where attrelid = 'public.organizations'::regclass and attname = 'platform_brand')) as b,
       (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'waitlist' and column_name = 'source') as s;

set client_min_messages = warning;
\i supabase/migrations/20261017100000_rebrand_everdoer_values.sql
set client_min_messages = notice;

do $$
begin
  raise notice '== rebrand values: second run';
  if exists (
    (select id, name, quote_public_base_url, email_from_address from public.companies where id::text like '00000000-0000-0000-0000-0000000e7c%'
     union all select id, name, null, null from public.organizations where id::text like '00000000-0000-0000-0000-0000000e7a%')
    except select * from rv_after1
  ) then raise exception 'FAIL second run changed a row'; end if;
  if (select email_from_address from public.companies where id = '00000000-0000-0000-0000-0000000e7c02') <> 'care@a1marinecare.ca' then raise exception 'FAIL second run overwrote a sender'; end if;
  if exists ((select step, target_table, target_column, row_id, old_value, new_value from public.rebrand_values_backup) except select * from rv_backup1)
     or exists (select * from rv_backup1 except (select step, target_table, target_column, row_id, old_value, new_value from public.rebrand_values_backup)) then
    raise exception 'FAIL second run changed the backup';
  end if;
  if exists (select 1 from rv_meta1 where w is distinct from obj_description('public.waitlist'::regclass)
      or d is distinct from obj_description('public.dfy_progress'::regclass)
      or s is distinct from (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'waitlist' and column_name = 'source')) then
    raise exception 'FAIL second run changed a comment or default';
  end if;
  raise notice 'ok   running it twice is a no-op (rows, backup, comments, default)';
end $$;

-- ── rollback restores ────────────────────────────────────────────────────────
-- A name changed by hand after the migration must survive the rollback.
update public.organizations set name = 'Everdoer Demo Co' where id = '00000000-0000-0000-0000-0000000e7a06';
set client_min_messages = warning;
\i supabase/rollback/20261017100000_rebrand_everdoer_values.down.sql
set client_min_messages = notice;

do $$
begin
  raise notice '== rebrand values: rollback';
  if exists (
    (select 'org', id, name, null::text from public.organizations where id::text like '00000000-0000-0000-0000-0000000e7a%' and id <> '00000000-0000-0000-0000-0000000e7a06'
     union all select 'company', id, name, quote_public_base_url from public.companies where id::text like '00000000-0000-0000-0000-0000000e7c%')
    except select * from rv_before
  ) then raise exception 'FAIL rollback did not restore every name / link'; end if;
  if (select name from public.organizations where id = '00000000-0000-0000-0000-0000000e7a06') <> 'Everdoer Demo Co' then raise exception 'FAIL rollback clobbered a name edited since'; end if;
  if exists (select 1 from rv_meta_before m where
      m.waitlist_comment is distinct from obj_description('public.waitlist'::regclass)
      or m.dfy_comment is distinct from obj_description('public.dfy_progress'::regclass)
      or m.brand_comment is distinct from col_description('public.organizations'::regclass, (select attnum from pg_attribute where attrelid = 'public.organizations'::regclass and attname = 'platform_brand'))
      or m.source_default is distinct from (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'waitlist' and column_name = 'source')) then
    raise exception 'FAIL rollback did not restore the comments / default';
  end if;
  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'waitlist' and column_name = 'source') <> '''empirevu.com''::text' then raise exception 'FAIL default not empirevu.com'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'companies' and column_name = 'email_from_address') then raise exception 'FAIL column still there'; end if;
  if to_regclass('public.rebrand_values_backup') is not null then raise exception 'FAIL backup table still there'; end if;
  raise notice 'ok   rollback restored names, links, comments and the default; dropped the column and the backup';
end $$;

-- ── and forward again ────────────────────────────────────────────────────────
update public.organizations set name = 'EmpireVu' where id = '00000000-0000-0000-0000-0000000e7a06';
set client_min_messages = warning;
\i supabase/migrations/20261017100000_rebrand_everdoer_values.sql
set client_min_messages = notice;
do $$
begin
  raise notice '== rebrand values: migrate again after the rollback';
  if (select count(*) from public.organizations where name = 'Everdoer' and id::text like '00000000-0000-0000-0000-0000000e7a%') <> 2 then raise exception 'FAIL re-migrate names'; end if;
  if (select quote_public_base_url from public.companies where id = '00000000-0000-0000-0000-0000000e7c06') <> 'https://app.everdoer.com' then raise exception 'FAIL re-migrate links'; end if;
  if (select count(*) from public.companies where email_from_address = 'quotes@a1marinestorage.ca') <> 5 then raise exception 'FAIL re-migrate A1 sender'; end if;
  if (select count(*) from public.rebrand_values_backup where step = 'name') <> 3 then raise exception 'FAIL re-migrate backup'; end if;
  raise notice 'ok   up → down → up';
end $$;
