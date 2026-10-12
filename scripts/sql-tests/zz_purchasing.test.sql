-- Privilege tests for Purchasing (Phase 4): 20261013130000_staff_purchasing.sql.
--   • every new table has RLS on and no client write privilege; anon reads nothing;
--   • suppliers (account numbers) are owner/admin-read only; the draft claims are service-role only;
--   • a member reads their org's recipes and orders (the job sheet), never another org's, and
--     can't read suppliers; an admin can;
--   • one preferred supplier per company; PO numbers are unique per company.
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['suppliers','material_recipes','purchase_orders','purchase_order_drafts','purchasing_daily_counts'];
begin
  raise notice '== purchasing: RLS on, no client writes';
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
  if has_table_privilege('authenticated', 'public.purchase_order_drafts', 'SELECT') or has_table_privilege('authenticated', 'public.purchasing_daily_counts', 'SELECT') then
    raise exception 'FAIL authenticated can read the claim tables';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'suppliers' and cmd = 'SELECT' and qual like '%is_organization_admin%') then
    raise exception 'FAIL suppliers is not admin-read only';
  end if;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing', array_length(all_tables, 1);
end $$;

-- ── Fixture: two orgs; a member and an admin in the first ─────────────────────────────
insert into auth.users (id, email) values
  ('b1000000-0000-4000-8000-000000000001', 'crew@purchasing.test'),
  ('b1000000-0000-4000-8000-000000000002', 'admin@purchasing.test')
on conflict do nothing;
insert into public.profiles (id, email, full_name) values
  ('b1000000-0000-4000-8000-000000000001', 'crew@purchasing.test', 'Mike Crew'),
  ('b1000000-0000-4000-8000-000000000002', 'admin@purchasing.test', 'Dana Admin')
on conflict do nothing;
insert into public.organizations (id, name, slug) values
  ('b2000000-0000-4000-8000-000000000001', 'Purchasing Test', 'purchasing-test'),
  ('b2000000-0000-4000-8000-000000000002', 'Other Org', 'purchasing-other')
on conflict do nothing;
insert into auth.users (id, email) values ('b1000000-0000-4000-8000-000000000003', 'owner@purchasing.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) values ('b1000000-0000-4000-8000-000000000003', 'owner@purchasing.test', 'Pat Owner') on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000003', 'owner')
on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'member'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'admin')
on conflict do nothing;
-- Re-runnable on a used database: pin the roles this test relies on.
update public.organization_memberships set role = 'member' where organization_id = 'b2000000-0000-4000-8000-000000000001' and profile_id = 'b1000000-0000-4000-8000-000000000001';
update public.organization_memberships set role = 'admin' where organization_id = 'b2000000-0000-4000-8000-000000000001' and profile_id = 'b1000000-0000-4000-8000-000000000002';
insert into public.companies (id, organization_id, name, slug) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Northshore', 'northshore-purchasing'),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'Elsewhere', 'elsewhere-purchasing')
on conflict do nothing;
insert into public.suppliers (id, organization_id, company_id, name, branch, email, account_number, preferred) values
  ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Home Depot Pro', 'Barrie', 'orders@hd.test', '12345', true)
on conflict do nothing;
insert into public.purchase_orders (id, organization_id, company_id, supplier_name, status, po_seq, po_number, lines) values
  ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Home Depot Pro (Barrie)', 'sent', 1, 'PO-1', '[{"label":"shingles","qty":22,"unit":"bundles"}]'),
  ('b5000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000002', 'Other', 'sent', 1, 'PO-1', '[]')
on conflict do nothing;

-- A member: reads their own org's orders, not suppliers, not another org's orders.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', false);
do $$
begin
  if (select count(*) from public.purchase_orders) <> 1 then raise exception 'FAIL member sees % orders (want 1: their org''s)', (select count(*) from public.purchase_orders); end if;
  if (select count(*) from public.suppliers) <> 0 then raise exception 'FAIL a member can read suppliers'; end if;
  raise notice 'ok   member: own org''s orders only, no suppliers';
end $$;
do $$
begin
  begin
    update public.purchase_orders set status = 'picked_up';
    raise exception 'FAIL member updated purchase_orders';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member update purchase_orders';
  end;
end $$;

-- An admin: reads suppliers.
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', false);
do $$
begin
  if (select count(*) from public.suppliers) <> 1 then raise exception 'FAIL admin can''t read suppliers'; end if;
  raise notice 'ok   admin reads suppliers';
end $$;
reset role;

-- Constraints.
do $$
begin
  begin
    insert into public.suppliers (organization_id, company_id, name, preferred) values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Second', true);
    raise exception 'FAIL two preferred suppliers';
  exception when unique_violation then
    raise notice 'ok   one preferred supplier per company';
  end;
  begin
    insert into public.purchase_orders (organization_id, company_id, po_seq, po_number) values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 1, 'PO-1');
    raise exception 'FAIL duplicate PO number';
  exception when unique_violation then
    raise notice 'ok   PO numbers unique per company';
  end;
end $$;

-- One open order per job; a cancelled one doesn't count; deleting the booking keeps the order.
insert into public.bookings (id, organization_id, company_id, title, scheduled_for, status)
values ('b6000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'Roof', '2026-10-15 12:00+00', 'confirmed')
on conflict do nothing;
insert into public.purchase_orders (id, organization_id, company_id, booking_id, status, po_seq, po_number, job_label) values
  ('b5000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 'cancelled', 2, 'PO-2', 'Jones - Roof'),
  ('b5000000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 'draft', 3, 'PO-3', 'Jones - Roof')
on conflict do nothing;
do $$
begin
  begin
    insert into public.purchase_orders (organization_id, company_id, booking_id, status, po_seq, po_number) values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 'draft', 4, 'PO-4');
    raise exception 'FAIL two open orders for one job';
  exception when unique_violation then
    raise notice 'ok   one open order per job (a cancelled one does not count)';
  end;
  delete from public.bookings where id = 'b6000000-0000-4000-8000-000000000001';
  if (select count(*) from public.purchase_orders where po_number in ('PO-2', 'PO-3') and company_id = 'b3000000-0000-4000-8000-000000000001' and booking_id is null and job_label = 'Jones - Roof') <> 2 then
    raise exception 'FAIL deleting the booking removed the order history';
  end if;
  raise notice 'ok   deleting a booking keeps its orders (booking_id set null, job_label kept)';
end $$;
