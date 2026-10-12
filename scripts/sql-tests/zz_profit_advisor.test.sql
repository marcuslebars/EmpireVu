-- Privilege tests for the Profit advisor (Phase 5): 20261014120000_staff_profit_advisor.sql.
--   • both tables have RLS on and no client write privilege; anon reads nothing;
--   • price_changes are owner/admin-read only (margins come from pay rates): a member reads
--     nothing, another org's admin reads nothing; the run claims are service-role only;
--   • a price change is only ever a raise of at most +15% (minimum too);
--   • one open question per price-list item; one weekly / pricing run per company per key;
--   • a deleted price-list item keeps its price history (item id set null).
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['price_changes','profit_advisor_runs','price_watch'];
begin
  raise notice '== profit advisor: RLS on, no client writes';
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
    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'FAIL anon can read %', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.profit_advisor_runs', 'SELECT') or has_table_privilege('authenticated', 'public.price_watch', 'SELECT') then
    raise exception 'FAIL authenticated can read profit_advisor_runs / price_watch';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'price_changes' and cmd = 'SELECT' and qual like '%is_organization_admin%') then
    raise exception 'FAIL price_changes is not admin-read only';
  end if;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing', array_length(all_tables, 1);
end $$;

-- ── Fixture: two orgs; a member and an admin in the first, an admin in the second ──────────
insert into auth.users (id, email) values
  ('c1000000-0000-4000-8000-000000000001', 'crew@profit.test'),
  ('c1000000-0000-4000-8000-000000000002', 'admin@profit.test'),
  ('c1000000-0000-4000-8000-000000000003', 'owner@profit.test'),
  ('c1000000-0000-4000-8000-000000000004', 'other@profit.test')
on conflict do nothing;
insert into public.profiles (id, email, full_name) values
  ('c1000000-0000-4000-8000-000000000001', 'crew@profit.test', 'Mike Crew'),
  ('c1000000-0000-4000-8000-000000000002', 'admin@profit.test', 'Dana Admin'),
  ('c1000000-0000-4000-8000-000000000003', 'owner@profit.test', 'Pat Owner'),
  ('c1000000-0000-4000-8000-000000000004', 'other@profit.test', 'Other Admin')
on conflict do nothing;
insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'Profit Test', 'profit-test'),
  ('c2000000-0000-4000-8000-000000000002', 'Other Org', 'profit-other')
on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'owner'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', 'owner')
on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'member'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'admin')
on conflict do nothing;
-- Re-runnable on a used database: pin the roles this test relies on.
update public.organization_memberships set role = 'member' where organization_id = 'c2000000-0000-4000-8000-000000000001' and profile_id = 'c1000000-0000-4000-8000-000000000001';
update public.organization_memberships set role = 'admin' where organization_id = 'c2000000-0000-4000-8000-000000000001' and profile_id = 'c1000000-0000-4000-8000-000000000002';
insert into public.companies (id, organization_id, name, slug) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Northshore', 'northshore-profit'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'Elsewhere', 'elsewhere-profit')
on conflict do nothing;
insert into public.service_catalog_items (id, organization_id, company_id, service_key, label, pricing_type, rate_cents) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'gutter_clean', 'Gutter cleaning', 'flat', 18900),
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'roof_vent', 'Roof vent', 'flat', 9000),
  ('c4000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'gutter_clean', 'Gutter cleaning', 'flat', 15000)
on conflict do nothing;
delete from public.price_changes where organization_id in ('c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002');
delete from public.profit_advisor_runs where organization_id in ('c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002');
insert into public.price_changes (id, organization_id, company_id, service_catalog_item_id, item_label, status, old_rate_cents, new_rate_cents, pct, basis) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Gutter cleaning', 'proposed', 18900, 21500, 14, '{"jobs":18,"marginPct":12}'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000003', 'Gutter cleaning', 'applied', 15000, 17000, 13, '{}');
insert into public.profit_advisor_runs (organization_id, company_id, kind, run_key, status) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'weekly', '2026-W42', 'sent');
delete from public.price_watch where organization_id in ('c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002');
insert into public.price_watch (organization_id, company_id, service_catalog_item_id, rate_cents) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 18900);

-- A member: no price history (margins come from pay rates), no runs.
set role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', false);
do $$
begin
  if (select count(*) from public.price_changes) <> 0 then raise exception 'FAIL a member can read price_changes'; end if;
  raise notice 'ok   member: no price changes';
end $$;
do $$
begin
  begin
    perform count(*) from public.profit_advisor_runs;
    raise exception 'FAIL member read profit_advisor_runs';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member read profit_advisor_runs';
  end;
  begin
    perform count(*) from public.price_watch;
    raise exception 'FAIL member read price_watch';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member read price_watch';
  end;
end $$;

-- An admin: their own org's price changes only; still can't write.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', false);
do $$
begin
  if (select count(*) from public.price_changes) <> 1 then raise exception 'FAIL admin sees % price changes (want 1: their org''s)', (select count(*) from public.price_changes); end if;
  raise notice 'ok   admin reads own org''s price changes only';
end $$;
do $$
begin
  begin
    update public.price_changes set status = 'applied';
    raise exception 'FAIL admin updated price_changes';
  exception when insufficient_privilege then
    raise notice 'ok   denied: admin update price_changes';
  end;
  begin
    insert into public.price_changes (organization_id, company_id, item_label, old_rate_cents, new_rate_cents, pct) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'x', 100, 110, 10);
    raise exception 'FAIL admin inserted price_changes';
  exception when insufficient_privilege then
    raise notice 'ok   denied: admin insert price_changes';
  end;
end $$;
reset role;

-- Constraints (as the service role would write).
do $$
begin
  begin
    insert into public.price_changes (organization_id, company_id, service_catalog_item_id, item_label, old_rate_cents, new_rate_cents, pct) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'Roof vent', 9000, 8500, -6);
    raise exception 'FAIL a price cut was stored';
  exception when check_violation then
    raise notice 'ok   never a cut';
  end;
  begin
    insert into public.price_changes (organization_id, company_id, service_catalog_item_id, item_label, old_rate_cents, new_rate_cents, pct) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'Roof vent', 9000, 10400, 16);
    raise exception 'FAIL a +16%% raise was stored';
  exception when check_violation then
    raise notice 'ok   never more than +15%%';
  end;
  begin
    insert into public.price_changes (organization_id, company_id, service_catalog_item_id, item_label, old_rate_cents, new_rate_cents, old_minimum_cents, new_minimum_cents, pct) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'Roof vent', 9000, 10000, 10000, 12000, 11);
    raise exception 'FAIL a +20%% minimum was stored';
  exception when check_violation then
    raise notice 'ok   the minimum is capped too';
  end;
  begin
    insert into public.price_changes (organization_id, company_id, service_catalog_item_id, item_label, old_rate_cents, new_rate_cents, pct) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Gutter cleaning', 18900, 20000, 6);
    raise exception 'FAIL two open questions for one item';
  exception when unique_violation then
    raise notice 'ok   one open question per item';
  end;
  -- +15% exactly is allowed; a decided one doesn't block a new question.
  insert into public.price_changes (organization_id, company_id, service_catalog_item_id, item_label, status, old_rate_cents, new_rate_cents, pct) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'Roof vent', 'declined', 9000, 10350, 15);
  insert into public.price_changes (organization_id, company_id, service_catalog_item_id, item_label, old_rate_cents, new_rate_cents, pct) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'Roof vent', 9000, 10000, 11);
  raise notice 'ok   +15%% allowed; declined rows don''t block';
  begin
    insert into public.profit_advisor_runs (organization_id, company_id, kind, run_key) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'weekly', '2026-W42');
    raise exception 'FAIL two weekly runs for one week';
  exception when unique_violation then
    raise notice 'ok   one weekly run per company per ISO week';
  end;
  begin
    insert into public.profit_advisor_runs (organization_id, company_id, kind, run_key) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'weekly', '2026-W42');
    raise exception 'FAIL a run for another org''s company';
  exception when foreign_key_violation then
    raise notice 'ok   runs are pinned to (company, organization)';
  end;
  -- A deleted price-list item keeps its history.
  delete from public.service_catalog_items where id = 'c4000000-0000-4000-8000-000000000003';
  if (select service_catalog_item_id from public.price_changes where id = 'c5000000-0000-4000-8000-000000000002') is not null then
    raise exception 'FAIL price change not kept when its item was deleted';
  end if;
  raise notice 'ok   a deleted item keeps its price history';
  begin
    insert into public.price_watch (organization_id, company_id, service_catalog_item_id, rate_cents) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 19900);
    raise exception 'FAIL two watch rows for one item';
  exception when unique_violation then
    raise notice 'ok   one price_watch row per item';
  end;
end $$;
