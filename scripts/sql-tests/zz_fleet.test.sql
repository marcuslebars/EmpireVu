-- Privilege tests for Fleet & equipment (Phase 5): 20261014130000_staff_fleet.sql.
--   • every new table has RLS on and no client write privilege; anon reads nothing;
--   • a member reads their own org's vehicles, equipment, rentals and log — never another org's;
--     the reminder claims are service-role only;
--   • one active vehicle name / one live equipment name per company, one schedule label per
--     vehicle; a schedule needs an interval; a log row has exactly one subject; one filing per
--     texted reading (source_key); a reminder stage is claimed once; a deleted job keeps the
--     rental and equipment (booking_id set null); deleting a vehicle takes its schedules and log.
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['vehicles','vehicle_service_items','equipment','rentals','fleet_log','fleet_reminders'];
begin
  raise notice '== fleet: RLS on, no client writes';
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
    if not has_table_privilege('service_role', 'public.' || t, 'INSERT') then
      raise exception 'FAIL service_role cannot write %', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.fleet_reminders', 'SELECT') then
    raise exception 'FAIL authenticated can read fleet_reminders';
  end if;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing, claims service-role only', array_length(all_tables, 1);
end $$;

-- ── Fixture: two orgs; a member of the first ───────────────────────────────────────────
insert into auth.users (id, email) values ('f1000000-0000-4000-8000-000000000001', 'crew@fleet.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) values ('f1000000-0000-4000-8000-000000000001', 'crew@fleet.test', 'Mike Crew') on conflict do nothing;
insert into public.organizations (id, name, slug) values
  ('f2000000-0000-4000-8000-000000000001', 'Fleet Test', 'fleet-test'),
  ('f2000000-0000-4000-8000-000000000002', 'Other Org', 'fleet-other')
on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'member')
on conflict do nothing;
update public.organization_memberships set role = 'member' where organization_id = 'f2000000-0000-4000-8000-000000000001' and profile_id = 'f1000000-0000-4000-8000-000000000001';
insert into public.companies (id, organization_id, name, slug) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'Northshore', 'northshore-fleet'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002', 'Elsewhere', 'elsewhere-fleet')
on conflict do nothing;
insert into public.vehicles (id, organization_id, company_id, name, plate, vin, odometer_km, plate_sticker_due) values
  ('f4000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Truck 2', 'ABCD 123', '1FTFW1E50KFA12345', 84200, '2027-03-31'),
  ('f4000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000002', 'Van', null, null, null, null)
on conflict do nothing;
insert into public.vehicle_service_items (id, organization_id, company_id, vehicle_id, label, every_km, last_done_km) values
  ('f5000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Oil change', 8000, 76000)
on conflict do nothing;
insert into public.equipment (id, organization_id, company_id, name, status) values
  ('f6000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Mini-ex', 'available'),
  ('f6000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000002', 'Mower', 'available')
on conflict do nothing;
insert into public.rentals (id, organization_id, company_id, item, vendor, due_back_at, rate_cents_per_day) values
  ('f7000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'mini-ex', 'Sunbelt', '2026-10-15 21:00+00', 38000)
on conflict do nothing;
insert into public.fleet_log (id, organization_id, company_id, vehicle_id, kind, reading, source_key) values
  ('f8000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'odometer', 84200, 'sms:log-1')
on conflict do nothing;
insert into public.fleet_reminders (organization_id, company_id, subject_type, subject_id, reminder_key, local_date) values
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'vehicle', 'f4000000-0000-4000-8000-000000000001', 'plate:2027-03-31:30', '2027-03-01')
on conflict do nothing;

-- A member: reads their own org's fleet, not another org's, not the claims; can't write.
set role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', false);
do $$
begin
  if (select count(*) from public.vehicles where active) <> 1 or exists (select 1 from public.vehicles where organization_id <> 'f2000000-0000-4000-8000-000000000001') then raise exception 'FAIL member sees % vehicles (want 1)', (select count(*) from public.vehicles where active); end if;
  if (select count(*) from public.equipment) <> 1 then raise exception 'FAIL member sees % equipment (want 1)', (select count(*) from public.equipment); end if;
  if (select count(*) from public.vehicle_service_items) <> 1 then raise exception 'FAIL member can''t read service items'; end if;
  if (select count(*) from public.rentals) <> 1 then raise exception 'FAIL member can''t read rentals'; end if;
  if (select count(*) from public.fleet_log) <> 1 then raise exception 'FAIL member can''t read the log'; end if;
  raise notice 'ok   member: own org''s vehicles, schedules, equipment, rentals and log only';
end $$;
do $$
begin
  begin
    perform count(*) from public.fleet_reminders;
    raise exception 'FAIL member read fleet_reminders';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member read fleet_reminders';
  end;
  begin
    update public.vehicles set odometer_km = 1;
    raise exception 'FAIL member updated vehicles';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member update vehicles';
  end;
  begin
    update public.rentals set returned_at = now();
    raise exception 'FAIL member updated rentals';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member update rentals';
  end;
  begin
    insert into public.fleet_log (organization_id, company_id, vehicle_id, kind, reading) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'odometer', 1);
    raise exception 'FAIL member inserted fleet_log';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member insert fleet_log';
  end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- Constraints.
do $$
begin
  begin
    insert into public.vehicles (organization_id, company_id, name) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', ' truck 2 ');
    raise exception 'FAIL two active vehicles called Truck 2';
  exception when unique_violation then
    raise notice 'ok   one active vehicle per name per company';
  end;
  -- A retired one doesn't count.
  insert into public.vehicles (id, organization_id, company_id, name, active) values ('f4000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Truck 2', false) on conflict (id) do nothing;
  raise notice 'ok   a retired vehicle can share the name';
  begin
    insert into public.vehicles (organization_id, company_id, name, vin) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Truck 9', 'bad vin!');
    raise exception 'FAIL a junk VIN was accepted';
  exception when check_violation then
    raise notice 'ok   VIN checked';
  end;
  begin
    insert into public.vehicle_service_items (organization_id, company_id, vehicle_id, label) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'Tires');
    raise exception 'FAIL a schedule without an interval';
  exception when check_violation then
    raise notice 'ok   a schedule needs every_km or every_months';
  end;
  begin
    insert into public.vehicle_service_items (organization_id, company_id, vehicle_id, label, every_months) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'OIL CHANGE', 6);
    raise exception 'FAIL two oil change schedules on one vehicle';
  exception when unique_violation then
    raise notice 'ok   one schedule per label per vehicle';
  end;
  begin
    insert into public.equipment (organization_id, company_id, name) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'mini-ex');
    raise exception 'FAIL two live Mini-ex';
  exception when unique_violation then
    raise notice 'ok   one live equipment name per company';
  end;
  begin
    insert into public.equipment (organization_id, company_id, name, status) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Saw', 'lost');
    raise exception 'FAIL a junk equipment status';
  exception when check_violation then
    raise notice 'ok   equipment status checked';
  end;
  begin
    insert into public.fleet_log (organization_id, company_id, vehicle_id, equipment_id, kind) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000001', 'check_out');
    raise exception 'FAIL a log row with two subjects';
  exception when check_violation then
    raise notice 'ok   a log row has exactly one subject';
  end;
  begin
    insert into public.fleet_log (organization_id, company_id, vehicle_id, kind, reading, source_key) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000001', 'odometer', 84300, 'sms:log-1');
    raise exception 'FAIL the same texted reading logged twice';
  exception when unique_violation then
    raise notice 'ok   one filing per texted reading';
  end;
  begin
    insert into public.fleet_reminders (organization_id, company_id, subject_type, subject_id, reminder_key, local_date) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'vehicle', 'f4000000-0000-4000-8000-000000000001', 'plate:2027-03-31:30', '2027-03-02');
    raise exception 'FAIL a reminder stage claimed twice';
  exception when unique_violation then
    raise notice 'ok   a reminder stage is claimed once';
  end;
  begin
    insert into public.rentals (organization_id, company_id, item, vendor_phone) values ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Lift', '705-555-0100');
    raise exception 'FAIL a non-E.164 vendor phone';
  exception when check_violation then
    raise notice 'ok   vendor phone is E.164';
  end;
end $$;

-- A deleted job keeps the rental and the equipment; deleting a vehicle takes its schedules and log.
insert into public.bookings (id, organization_id, company_id, title, scheduled_for, status)
values ('f9000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'Dig', '2026-10-15 12:00+00', 'confirmed')
on conflict do nothing;
update public.rentals set booking_id = 'f9000000-0000-4000-8000-000000000001' where id = 'f7000000-0000-4000-8000-000000000001';
update public.equipment set booking_id = 'f9000000-0000-4000-8000-000000000001', status = 'out' where id = 'f6000000-0000-4000-8000-000000000001';
do $$
begin
  delete from public.bookings where id = 'f9000000-0000-4000-8000-000000000001';
  if (select count(*) from public.rentals where id = 'f7000000-0000-4000-8000-000000000001' and booking_id is null) <> 1 then raise exception 'FAIL deleting the job removed the rental'; end if;
  if (select count(*) from public.equipment where id = 'f6000000-0000-4000-8000-000000000001' and booking_id is null) <> 1 then raise exception 'FAIL deleting the job removed the equipment'; end if;
  raise notice 'ok   a deleted job keeps its rental and equipment (booking_id set null)';
  delete from public.vehicles where id = 'f4000000-0000-4000-8000-000000000001';
  if exists (select 1 from public.vehicle_service_items where vehicle_id = 'f4000000-0000-4000-8000-000000000001') or exists (select 1 from public.fleet_log where vehicle_id = 'f4000000-0000-4000-8000-000000000001') then
    raise exception 'FAIL deleting a vehicle left its schedules or log';
  end if;
  raise notice 'ok   deleting a vehicle removes its schedules and log';
end $$;

-- updated_at triggers.
do $$
declare
  before timestamptz;
begin
  update public.equipment set updated_at = '2020-01-01' where id = 'f6000000-0000-4000-8000-000000000001';
  select updated_at into before from public.equipment where id = 'f6000000-0000-4000-8000-000000000001';
  update public.equipment set location = 'yard' where id = 'f6000000-0000-4000-8000-000000000001';
  if (select updated_at from public.equipment where id = 'f6000000-0000-4000-8000-000000000001') <= '2020-01-02' then raise exception 'FAIL equipment updated_at not touched'; end if;
  raise notice 'ok   updated_at touched on update';
end $$;
