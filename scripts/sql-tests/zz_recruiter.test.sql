-- Privilege + lock tests for the Recruiter (Phase 3): 20261012130000_staff_recruiter.sql.
--   • every new table has RLS on and no client write policy; anon can't read; the claims table is
--     service-role only; applicants and the audit log are owner/admin-read only;
--   • the time_entries lock: a member can't insert / edit / delete an entry inside a LOCKED pay
--     period (pay_period_locked), CAN stop a clock left running in it, and is unaffected once the
--     period is unlocked; the service role is never blocked.
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['pay_periods','pay_period_events','job_postings','job_applicants','recruiter_sweep_claims'];
begin
  raise notice '== recruiter: RLS on, no client writes';
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
  if has_table_privilege('authenticated', 'public.recruiter_sweep_claims', 'SELECT') then
    raise exception 'FAIL authenticated can read recruiter_sweep_claims';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'job_applicants' and cmd = 'SELECT' and qual like '%is_organization_admin%') then
    raise exception 'FAIL job_applicants is not admin-read only';
  end if;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing', array_length(all_tables, 1);
end $$;

-- ── The lock ───────────────────────────────────────────────────────────────────────
-- Fixture: an org, a company, a crew member with two entries in Sep 28 - Oct 11 (one still running).
insert into auth.users (id, email) values ('a1000000-0000-4000-8000-000000000001', 'crew@recruiter.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) values ('a1000000-0000-4000-8000-000000000001', 'crew@recruiter.test', 'Mike Crew') on conflict do nothing;
insert into public.organizations (id, name, slug) values ('a2000000-0000-4000-8000-000000000001', 'Recruiter Test', 'recruiter-test') on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'member') on conflict do nothing;
insert into public.companies (id, organization_id, name, slug) values ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Northshore', 'northshore-recruiter') on conflict do nothing;
insert into public.time_entries (id, organization_id, company_id, profile_id, started_at, ended_at, break_minutes, source)
values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '2026-10-05 12:00+00', '2026-10-05 20:00+00', 30, 'manual'),
  ('a4000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '2026-10-11 12:00+00', null, 0, 'clock')
on conflict do nothing;
insert into public.pay_periods (id, organization_id, company_id, frequency, start_date, end_date, starts_at, ends_at, status)
values ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'biweekly', '2026-09-28', '2026-10-11', '2026-09-28 04:00+00', '2026-10-12 04:00+00', 'locked')
on conflict (id) do update set status = 'locked';

set role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false);

do $$
begin
  begin
    update public.time_entries set break_minutes = 0 where id = 'a4000000-0000-4000-8000-000000000001';
    raise exception 'FAIL edited a locked entry';
  exception when others then
    if sqlerrm not like '%pay_period_locked%' then raise; end if;
  end;
  raise notice 'ok   denied: editing an entry in a locked period';

  begin
    delete from public.time_entries where id = 'a4000000-0000-4000-8000-000000000001';
    raise exception 'FAIL deleted a locked entry';
  exception when others then
    if sqlerrm not like '%pay_period_locked%' then raise; end if;
  end;
  raise notice 'ok   denied: deleting an entry in a locked period';

  begin
    insert into public.time_entries (organization_id, company_id, profile_id, started_at, ended_at, source)
    values ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '2026-10-06 12:00+00', '2026-10-06 14:00+00', 'manual');
    raise exception 'FAIL backdated an entry into a locked period';
  exception when others then
    if sqlerrm not like '%pay_period_locked%' then raise; end if;
  end;
  raise notice 'ok   denied: adding an entry inside a locked period';

  update public.time_entries set ended_at = '2026-10-11 20:00+00' where id = 'a4000000-0000-4000-8000-000000000002';
  raise notice 'ok   allowed: stopping a clock left running in a locked period';

  insert into public.time_entries (organization_id, company_id, profile_id, started_at, ended_at, source)
  values ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', '2026-10-13 12:00+00', '2026-10-13 14:00+00', 'manual');
  raise notice 'ok   allowed: an entry after the locked period';
end $$;

reset role;
update public.pay_periods set status = 'unlocked' where id = 'a5000000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false);
do $$
begin
  update public.time_entries set break_minutes = 15 where id = 'a4000000-0000-4000-8000-000000000001';
  raise notice 'ok   allowed: editing once the period is unlocked';
end $$;

reset role;
update public.pay_periods set status = 'locked' where id = 'a5000000-0000-4000-8000-000000000001';
set role service_role;
do $$
begin
  update public.time_entries set break_minutes = 20 where id = 'a4000000-0000-4000-8000-000000000001';
  raise notice 'ok   allowed: the service role is never blocked by the lock';
end $$;
reset role;
do $$ begin raise notice '== recruiter: privilege + lock tests passed'; end $$;
