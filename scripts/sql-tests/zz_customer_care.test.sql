-- Privilege tests for Customer care & warranty (Phase 5): 20261014110000_staff_customer_care.sql.
--   • every new table has RLS on and no client write privilege; anon reads nothing;
--   • the customer-text outbox is service-role only;
--   • check-ins and cases (customers' complaints) are owner/admin-read only; a member reads their
--     org's warranties, equipment and visit links, never another org's;
--   • one check-in per job, one case per check-in answer, one open warranty claim per customer,
--     one case link per booking; a deleted booking keeps its case (booking_id set null).
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['warranty_terms','job_warranties','installed_equipment','care_checkins','care_cases','care_case_bookings','care_messages'];
begin
  raise notice '== customer care: RLS on, no client writes';
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
  if has_table_privilege('authenticated', 'public.care_messages', 'SELECT') then
    raise exception 'FAIL authenticated can read the outbox';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'care_cases' and cmd = 'SELECT' and qual like '%is_organization_admin%') then
    raise exception 'FAIL care_cases is not admin-read only';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'care_checkins' and cmd = 'SELECT' and qual like '%is_organization_admin%') then
    raise exception 'FAIL care_checkins is not admin-read only';
  end if;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing, outbox service-role only', array_length(all_tables, 1);
end $$;

-- ── Fixture: two orgs; a member and an admin in the first ─────────────────────────────
insert into auth.users (id, email) values
  ('c1000000-0000-4000-8000-000000000001', 'crew@care.test'),
  ('c1000000-0000-4000-8000-000000000002', 'admin@care.test')
on conflict do nothing;
insert into public.profiles (id, email, full_name) values
  ('c1000000-0000-4000-8000-000000000001', 'crew@care.test', 'Mike Crew'),
  ('c1000000-0000-4000-8000-000000000002', 'admin@care.test', 'Dana Admin')
on conflict do nothing;
insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'Care Test', 'care-test'),
  ('c2000000-0000-4000-8000-000000000002', 'Other Org', 'care-other')
on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'member'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'admin')
on conflict do nothing;
update public.organization_memberships set role = 'member' where organization_id = 'c2000000-0000-4000-8000-000000000001' and profile_id = 'c1000000-0000-4000-8000-000000000001';
update public.organization_memberships set role = 'admin' where organization_id = 'c2000000-0000-4000-8000-000000000001' and profile_id = 'c1000000-0000-4000-8000-000000000002';
insert into public.companies (id, organization_id, name, slug) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Northshore', 'northshore-care'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'Elsewhere', 'elsewhere-care')
on conflict do nothing;
insert into public.contacts (id, organization_id, company_id, first_name, last_name) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'Dana', 'Jones'),
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'Pat', 'Other')
on conflict do nothing;
insert into public.bookings (id, organization_id, company_id, contact_id, title, scheduled_for, status) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Roof', '2026-05-04 12:00+00', 'completed'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', 'Deck', '2026-05-04 12:00+00', 'completed'),
  ('c5000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'Callback: Roof', '2026-10-15 13:00+00', 'pending')
on conflict do nothing;
insert into public.job_warranties (id, organization_id, company_id, contact_id, booking_id, job_label, starts_on, ends_on, months) values
  ('c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'roof', '2026-05-04', '2027-05-04', 12),
  ('c6000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', 'deck', '2026-05-04', '2027-05-04', 12)
on conflict do nothing;
insert into public.care_checkins (id, organization_id, company_id, contact_id, booking_id, status, send_at, rating) values
  ('c7000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'sent', '2026-05-05 14:00+00', 2)
on conflict do nothing;
insert into public.care_cases (id, organization_id, company_id, contact_id, booking_id, kind, status, opened_via, checkin_id, rating, job_label) values
  ('c8000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'complaint', 'open', 'checkin', 'c7000000-0000-4000-8000-000000000001', 2, 'roof')
on conflict do nothing;
insert into public.care_case_bookings (organization_id, company_id, case_id, booking_id, kind) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', 'callback')
on conflict do nothing;

-- A member: their org's warranties and visit links; no cases, no check-ins.
set role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', false);
do $$
begin
  if (select count(*) from public.job_warranties) <> 1 then raise exception 'FAIL member sees % warranties (want 1: their org''s)', (select count(*) from public.job_warranties); end if;
  if (select count(*) from public.care_case_bookings) <> 1 then raise exception 'FAIL member can''t see the visit link'; end if;
  if (select count(*) from public.care_cases) <> 0 then raise exception 'FAIL a member can read care cases'; end if;
  if (select count(*) from public.care_checkins) <> 0 then raise exception 'FAIL a member can read check-ins'; end if;
  raise notice 'ok   member: own org''s warranties and visit links only; no cases or check-ins';
end $$;
do $$
begin
  begin
    update public.care_cases set status = 'resolved';
    raise exception 'FAIL member updated care_cases';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member update care_cases';
  end;
  begin
    insert into public.job_warranties (organization_id, company_id, booking_id, starts_on, ends_on, months) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', '2026-01-01', '2036-01-01', 120);
    raise exception 'FAIL member inserted a warranty';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member insert job_warranties';
  end;
end $$;

-- An admin: reads cases and check-ins of their org.
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', false);
do $$
begin
  if (select count(*) from public.care_cases) <> 1 then raise exception 'FAIL admin can''t read cases'; end if;
  if (select count(*) from public.care_checkins) <> 1 then raise exception 'FAIL admin can''t read check-ins'; end if;
  begin
    update public.care_checkins set rating = 5;
    raise exception 'FAIL admin updated a check-in rating';
  exception when insufficient_privilege then
    raise notice 'ok   denied: admin update care_checkins';
  end;
  raise notice 'ok   admin reads cases and check-ins';
end $$;
reset role;

-- Constraints.
do $$
begin
  begin
    insert into public.care_checkins (organization_id, company_id, booking_id, send_at) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', now());
    raise exception 'FAIL two check-ins for one job';
  exception when unique_violation then
    raise notice 'ok   one check-in per job';
  end;
  begin
    insert into public.care_cases (organization_id, company_id, contact_id, kind, opened_via, checkin_id) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'complaint', 'checkin', 'c7000000-0000-4000-8000-000000000001');
    raise exception 'FAIL two cases for one check-in answer';
  exception when unique_violation then
    raise notice 'ok   one case per check-in answer';
  end;
  insert into public.care_cases (organization_id, company_id, contact_id, kind, status, opened_via) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'warranty', 'open', 'sms_agent');
  begin
    insert into public.care_cases (organization_id, company_id, contact_id, kind, status, opened_via) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'warranty', 'scheduled', 'sms_agent');
    raise exception 'FAIL two open warranty claims for one customer';
  exception when unique_violation then
    raise notice 'ok   one open warranty claim per customer';
  end;
  update public.care_cases set status = 'resolved' where kind = 'warranty' and company_id = 'c3000000-0000-4000-8000-000000000001';
  insert into public.care_cases (organization_id, company_id, contact_id, kind, status, opened_via) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'warranty', 'open', 'sms_agent');
  raise notice 'ok   a resolved claim doesn''t block a new one';
  delete from public.care_cases where kind = 'warranty' and company_id = 'c3000000-0000-4000-8000-000000000001';
  begin
    insert into public.care_case_bookings (organization_id, company_id, case_id, booking_id, kind) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', 'warranty');
    raise exception 'FAIL one booking linked twice';
  exception when unique_violation then
    raise notice 'ok   one case link per booking';
  end;
  begin
    insert into public.care_checkins (organization_id, company_id, booking_id, send_at, rating) values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003', now(), 7);
    raise exception 'FAIL rating 7 accepted';
  exception when check_violation then
    raise notice 'ok   ratings are 1-5';
  end;
end $$;

-- The callback booking can go; the case stays (its link goes with the booking).
do $$
begin
  delete from public.bookings where id = 'c5000000-0000-4000-8000-000000000003';
  if exists (select 1 from public.care_case_bookings where booking_id = 'c5000000-0000-4000-8000-000000000003') then raise exception 'FAIL the link outlived the booking'; end if;
  if not exists (select 1 from public.care_cases where id = 'c8000000-0000-4000-8000-000000000001') then raise exception 'FAIL deleting a visit removed the case'; end if;
  raise notice 'ok   deleting a visit keeps the case';
end $$;
