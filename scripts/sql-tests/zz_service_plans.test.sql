-- Privilege tests for Service plans (Phase 4): 20261013110000_staff_service_plans.sql.
--   • every new table has RLS on and no client writes; anon reads nothing; the run claims are
--     service-role only; agreements and texts are owner/admin-read only;
--   • the renewal token (the customer's credential) is not readable by any client role;
--   • the one-open-agreement-per-customer-per-plan index; recurring_jobs.visit_dates exists and
--     defaults to NULL (every existing series keeps its rule).
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['service_plans','service_agreements','service_plan_messages','service_plan_runs'];
begin
  raise notice '== service plans: RLS on, no client writes';
  foreach t in array all_tables loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL % has RLS off', t;
    end if;
    foreach r in array array['anon','authenticated'] loop
      foreach p in array array['INSERT','UPDATE','DELETE'] loop
        if has_table_privilege(r, 'public.' || t, p) then
          raise exception 'FAIL % has % on %', r, p, t;
        end if;
      end loop;
    end loop;
    if has_table_privilege('anon', 'public.' || t, 'SELECT') or has_any_column_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'FAIL anon can read %', t;
    end if;
  end loop;
  if has_any_column_privilege('authenticated', 'public.service_plan_runs', 'SELECT') then
    raise exception 'FAIL authenticated can read service_plan_runs';
  end if;
  foreach t in array array['service_agreements','service_plan_messages'] loop
    if not exists (select 1 from pg_policies where tablename = t and cmd = 'SELECT' and qual like '%is_organization_admin%') then
      raise exception 'FAIL % is not admin-read only', t;
    end if;
  end loop;
  if not exists (select 1 from pg_policies where tablename = 'service_plans' and cmd = 'SELECT' and qual like '%is_organization_member%') then
    raise exception 'FAIL service_plans is not member-readable';
  end if;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing', array_length(all_tables, 1);

  if has_column_privilege('authenticated', 'public.service_agreements', 'renewal_token', 'SELECT') then
    raise exception 'FAIL authenticated can read service_agreements.renewal_token';
  end if;
  if not has_column_privilege('authenticated', 'public.service_agreements', 'status', 'SELECT') then
    raise exception 'FAIL authenticated can''t read service_agreements.status (Settings)';
  end if;
  if not has_column_privilege('service_role', 'public.service_agreements', 'renewal_token', 'SELECT') then
    raise exception 'FAIL service_role can''t read the renewal token';
  end if;
  raise notice 'ok   renewal_token: service role only';

  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'recurring_jobs' and column_name = 'visit_dates') is not null then
    raise exception 'FAIL recurring_jobs.visit_dates has a default (existing series must keep NULL)';
  end if;
  raise notice 'ok   recurring_jobs.visit_dates: nullable, no default';
end $$;

-- ── One open agreement per customer per plan ────────────────────────────────────────
insert into public.organizations (id, name, slug) values ('b2000000-0000-4000-8000-000000000001', 'Plans Test', 'plans-test') on conflict do nothing;
insert into public.companies (id, organization_id, name, slug) values ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Northshore Lawn', 'northshore-plans') on conflict do nothing;
insert into public.contacts (id, organization_id, company_id, first_name, phone) values ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Dana', '+17055550123') on conflict do nothing;
insert into public.service_plans (id, organization_id, company_id, name, price_cents, billing, visit_months)
values ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Spring + Fall', 42000, 'annual', '{5,10}')
on conflict do nothing;
insert into public.service_agreements (id, organization_id, company_id, plan_id, contact_id, status, plan_name, billing, price_cents, visit_months)
values ('b6000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'active', 'Spring + Fall', 'annual', 42000, '{5,10}')
on conflict do nothing;

do $$
begin
  begin
    insert into public.service_agreements (organization_id, company_id, plan_id, contact_id, status, plan_name, billing, price_cents, visit_months)
    values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'pending_owner', 'Spring + Fall', 'annual', 42000, '{5,10}');
    raise exception 'FAIL a second open agreement for the same customer + plan was allowed';
  exception when unique_violation then
    raise notice 'ok   one open agreement per customer per plan';
  end;
  -- A renewed (closed) row next to the new term's active one is fine.
  update public.service_agreements set status = 'renewed' where id = 'b6000000-0000-4000-8000-000000000001';
  insert into public.service_agreements (organization_id, company_id, plan_id, contact_id, status, source, plan_name, billing, price_cents, visit_months, previous_agreement_id)
  values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'active', 'renewal', 'Spring + Fall', 'annual', 42000, '{5,10}', 'b6000000-0000-4000-8000-000000000001');
  raise notice 'ok   renewed + next term coexist';
  begin
    update public.service_agreements set renewal_token = 'not-a-token' where id = 'b6000000-0000-4000-8000-000000000001';
    raise exception 'FAIL a malformed renewal token was accepted';
  exception when check_violation then
    raise notice 'ok   renewal_token format checked';
  end;
end $$;

-- Clean up the fixture (cascades through the company).
delete from public.service_agreements where organization_id = 'b2000000-0000-4000-8000-000000000001';
delete from public.organizations where id = 'b2000000-0000-4000-8000-000000000001';
