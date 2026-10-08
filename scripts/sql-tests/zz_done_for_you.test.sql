-- Privilege tests for the done-for-you tables (20261008100000 … 20261008150000).
--
-- Runs after lock_privileged_columns.test.sql (file order) and reuses its sqltest helpers and
-- fixture users / orgs (re-inserted here with ON CONFLICT DO NOTHING so the file also reads on
-- its own). Asserts:
--   • setup_intakes / company_sites / dfy_progress / operator_actions are NOT client-writable
--     (insert / update / delete) by owners, admins, members or anon — including the new
--     columns (switch_on_attempts …);
--   • the no-login credentials setup_intakes.token and dfy_progress.forward_token are NOT
--     readable by any client role (members, admins and owners alike — the server hands the
--     links to owners/admins); the other columns stay readable to org members;
--   • anon can't read company_sites (the public page is served by the server);
--   • the composite (company_id, organization_id) FKs refuse a company from another org;
--   • updated_at is maintained by the trigger.

\set ON_ERROR_STOP on
set client_min_messages = warning;

reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@a.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@a.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'member@a.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner@b.test')
on conflict do nothing;
insert into public.organizations (id, name, slug, plan, subscription_status, created_by) values
  ('00000000-0000-0000-0000-00000000aaaa', 'Org A', 'org-a', 'launch', 'active', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000bbbb', 'Org B', 'org-b', 'launch', 'active', '00000000-0000-0000-0000-0000000000b1')
on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000000a3', 'member'),
  ('00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-0000000000b1', 'owner')
on conflict do nothing;
insert into public.companies (id, organization_id, name, slug) values
  ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-00000000aaaa', 'Brand A', 'brand-a'),
  ('00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000bbbb', 'Brand B', 'brand-b')
on conflict do nothing;

insert into public.setup_intakes (id, organization_id, company_id, token, status) values
  ('00000000-0000-0000-0000-0000000d1a01', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'setup-token-org-a-xxxxxxxxxxxxxxxx', 'sent')
on conflict do nothing;
insert into public.company_sites (id, organization_id, company_id, slug, status) values
  ('00000000-0000-0000-0000-0000000d2a01', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'brand-a', 'draft')
on conflict do nothing;
insert into public.dfy_progress (organization_id, company_id, forward_token) values
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'forward-token-org-a-xxxxxxxxxxxxx')
on conflict do nothing;

create schema if not exists sqltest;
grant usage on schema sqltest to anon, authenticated, service_role;

-- A SELECT that must fail with insufficient_privilege (column / table grant).
create or replace procedure sqltest.expect_select_denied(label text, stmt text)
language plpgsql as $$
begin
  begin
    execute stmt;
  exception
    when insufficient_privilege then
      raise notice 'ok   denied: %', label;
      return;
  end;
  raise exception 'FAIL % — read was ALLOWED but must be denied', label;
end $$;

-- A SELECT that must succeed and return exactly n rows.
create or replace procedure sqltest.expect_select_rows(label text, stmt text, n integer)
language plpgsql as $$
declare
  got integer;
begin
  execute format('select count(*) from (%s) q', stmt) into got;
  if got <> n then
    raise exception 'FAIL % — expected % row(s), got %', label, n, got;
  end if;
  raise notice 'ok   allowed: %', label;
end $$;

-- Writes must be refused (privilege error) or have no effect (RLS hides the row).
create or replace procedure sqltest.expect_write_refused(label text, stmt text)
language plpgsql as $$
declare
  got integer;
begin
  begin
    execute stmt;
    get diagnostics got = row_count;
  exception
    when insufficient_privilege then
      raise notice 'ok   denied: %', label;
      return;
    when others then
      if sqlerrm like '%row-level security%' then
        raise notice 'ok   denied (RLS): %', label;
        return;
      end if;
      raise exception 'FAIL % — expected a privilege error, got % (%)', label, sqlstate, sqlerrm;
  end;
  if got <> 0 then
    raise exception 'FAIL % — write was ALLOWED (% rows) but must be refused', label, got;
  end if;
  raise notice 'ok   no effect: %', label;
end $$;

grant execute on all procedures in schema sqltest to anon, authenticated, service_role;

set client_min_messages = notice;

-- ═════════════════════════════════════════════════════════════════════════════
-- Writes: owner, admin, member of Org A — none may write the done-for-you tables
-- ═════════════════════════════════════════════════════════════════════════════
do $$ begin raise notice '== done-for-you tables: client writes'; end $$;
set role authenticated;
set request.jwt.claim.role = 'authenticated';

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1'; -- owner
call sqltest.expect_write_refused('owner updates setup_intakes.status',
  $$update public.setup_intakes set status = 'enriched' where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner rewrites setup_intakes.token',
  $$update public.setup_intakes set token = 'mine' where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner inserts a setup_intakes row',
  $$insert into public.setup_intakes (organization_id, company_id, token) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'x')$$);
call sqltest.expect_write_refused('owner publishes company_sites directly',
  $$update public.company_sites set status = 'published' where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner inserts a company_sites row',
  $$insert into public.company_sites (organization_id, company_id, slug) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'other')$$);
call sqltest.expect_write_refused('owner deletes company_sites',
  $$delete from public.company_sites where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner stamps dfy_progress.switched_on_at',
  $$update public.dfy_progress set switched_on_at = now() where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner resets dfy_progress.switch_on_attempts (new column)',
  $$update public.dfy_progress set switch_on_attempts = 0 where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner writes operator_actions',
  $$insert into public.operator_actions (operator_email, action) values ('me@a.test', 'x')$$);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2'; -- admin
call sqltest.expect_write_refused('admin updates setup_intakes.answers',
  $$update public.setup_intakes set answers = '{}'::jsonb where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('admin updates company_sites.content',
  $$update public.company_sites set content = '{}'::jsonb where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('admin sets dfy_progress.forward_token',
  $$update public.dfy_progress set forward_token = 'guess' where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3'; -- member
call sqltest.expect_write_refused('member updates setup_intakes',
  $$update public.setup_intakes set status = 'failed' where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('member deletes dfy_progress',
  $$delete from public.dfy_progress where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);

-- ═════════════════════════════════════════════════════════════════════════════
-- Reads: token columns are not client-readable; the rest is (org members only)
-- ═════════════════════════════════════════════════════════════════════════════
do $$ begin raise notice '== done-for-you tables: token columns'; end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3'; -- member
call sqltest.expect_select_denied('member reads setup_intakes.token',
  $$select token from public.setup_intakes$$);
call sqltest.expect_select_denied('member reads setup_intakes.* (includes token)',
  $$select * from public.setup_intakes$$);
call sqltest.expect_select_denied('member reads dfy_progress.forward_token',
  $$select forward_token from public.dfy_progress$$);
call sqltest.expect_select_rows('member reads setup_intakes.status (own org)',
  $$select status from public.setup_intakes$$, 1);
call sqltest.expect_select_rows('member reads dfy_progress.switched_on_at, switch_on_attempts (own org)',
  $$select switched_on_at, switch_on_attempts from public.dfy_progress$$, 1);
call sqltest.expect_select_rows('member reads company_sites (own org)',
  $$select slug, status from public.company_sites$$, 1);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2'; -- admin
call sqltest.expect_select_denied('admin reads setup_intakes.token (links come from the server)',
  $$select token from public.setup_intakes$$);
call sqltest.expect_select_denied('admin reads dfy_progress.forward_token',
  $$select forward_token from public.dfy_progress$$);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1'; -- other org's owner
call sqltest.expect_select_rows('Org B owner sees none of Org A''s intakes', $$select status from public.setup_intakes$$, 0);
call sqltest.expect_select_rows('Org B owner sees none of Org A''s progress', $$select switched_on_at from public.dfy_progress$$, 0);

reset request.jwt.claim.sub;
set role anon;
call sqltest.expect_select_denied('anon reads company_sites', $$select slug from public.company_sites$$);
call sqltest.expect_select_denied('anon reads setup_intakes.status', $$select status from public.setup_intakes$$);
call sqltest.expect_select_denied('anon reads dfy_progress', $$select switched_on_at from public.dfy_progress$$);

-- ═════════════════════════════════════════════════════════════════════════════
-- Integrity (as the table owner)
-- ═════════════════════════════════════════════════════════════════════════════
reset role;
reset request.jwt.claim.role;
do $$ begin raise notice '== done-for-you tables: integrity'; end $$;
do $$
begin
  begin
    insert into public.setup_intakes (organization_id, company_id, token)
      values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0b01', 'cross-org-token');
    raise exception 'FAIL setup_intakes accepted a company from another org';
  exception when foreign_key_violation then
    raise notice 'ok   denied: setup_intakes (company of Org B under Org A) — composite FK';
  end;
  begin
    insert into public.company_sites (organization_id, company_id, slug)
      values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0b01', 'cross-org');
    raise exception 'FAIL company_sites accepted a company from another org';
  exception when foreign_key_violation then
    raise notice 'ok   denied: company_sites (company of Org B under Org A) — composite FK';
  end;
end $$;

do $$
declare
  before timestamptz;
  after timestamptz;
begin
  update public.setup_intakes set updated_at = '2000-01-01' where id = '00000000-0000-0000-0000-0000000d1a01';
  select updated_at into before from public.setup_intakes where id = '00000000-0000-0000-0000-0000000d1a01';
  if before < '2001-01-01' then
    raise exception 'FAIL setup_intakes.updated_at was not maintained by the trigger';
  end if;
  update public.company_sites set status = 'draft' where id = '00000000-0000-0000-0000-0000000d2a01';
  select updated_at into after from public.company_sites where id = '00000000-0000-0000-0000-0000000d2a01';
  if after < now() - interval '1 minute' then
    raise exception 'FAIL company_sites.updated_at was not maintained by the trigger';
  end if;
  raise notice 'ok   updated_at triggers on setup_intakes / company_sites';
end $$;

-- The service role still writes everything (the server's own path).
set role service_role;
set request.jwt.claim.role = 'service_role';
call sqltest.expect_select_rows('service_role reads the tokens', $$select token from public.setup_intakes where token is not null$$, 1);
do $$
begin
  update public.dfy_progress set switch_on_attempts = switch_on_attempts + 1 where company_id = '00000000-0000-0000-0000-0000000c0a01';
  raise notice 'ok   allowed: service_role updates dfy_progress.switch_on_attempts';
end $$;
reset role;
reset request.jwt.claim.role;
