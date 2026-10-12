-- Privilege tests for Compliance (Phase 4): 20261013120000_staff_compliance.sql.
--   • every new table has RLS on and no client insert / update / delete; anon reads nothing;
--   • upload links, shared links and the audit trail (tokens, visitor IPs) are service-role only;
--   • documents and subs are owner/admin-read only: an admin sees their org's rows, a plain member
--     sees none, an admin of another org sees none;
--   • the holder rule (company / crew / sub / pending) and the one-intake-per-source key hold;
--   • the bucket is private.
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['subcontractors','compliance_documents','compliance_upload_requests','compliance_shares','compliance_events','compliance_uploads'];
  hidden text[] := array['compliance_upload_requests','compliance_shares','compliance_events','compliance_uploads'];
begin
  raise notice '== compliance: RLS on, no client writes';
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
  foreach t in array hidden loop
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception 'FAIL authenticated can read % (tokens / visitor details)', t;
    end if;
  end loop;
  foreach t in array array['subcontractors','compliance_documents'] loop
    if not exists (select 1 from pg_policies where tablename = t and cmd = 'SELECT' and qual like '%is_organization_admin%') then
      raise exception 'FAIL % is not admin-read only', t;
    end if;
  end loop;
  if exists (select 1 from storage.buckets where id = 'compliance-docs' and public) then
    raise exception 'FAIL compliance-docs bucket is public';
  end if;
  if not exists (select 1 from storage.buckets where id = 'compliance-docs') then
    raise exception 'FAIL compliance-docs bucket missing';
  end if;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing; links + audit service-role only; private bucket', array_length(all_tables, 1);
end $$;

-- Fixture: an org with an admin and a member, another org's admin, a company, a sub and two docs.
insert into auth.users (id, email) values
  ('c1000000-0000-4000-8000-000000000001', 'admin@compliance.test'),
  ('c1000000-0000-4000-8000-000000000002', 'member@compliance.test'),
  ('c1000000-0000-4000-8000-000000000003', 'other@compliance.test')
on conflict do nothing;
insert into public.profiles (id, email, full_name) values
  ('c1000000-0000-4000-8000-000000000001', 'admin@compliance.test', 'Dana Admin'),
  ('c1000000-0000-4000-8000-000000000002', 'member@compliance.test', 'Mike Crew'),
  ('c1000000-0000-4000-8000-000000000003', 'other@compliance.test', 'Other Admin')
on conflict do nothing;
insert into public.organizations (id, name, slug) values
  ('c2000000-0000-4000-8000-000000000001', 'Compliance Test', 'compliance-test'),
  ('c2000000-0000-4000-8000-000000000002', 'Other Org', 'compliance-other')
on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'admin'),
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'member'),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003', 'admin')
on conflict do nothing;
insert into public.companies (id, organization_id, name, slug) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'Northshore', 'northshore-compliance')
on conflict do nothing;
insert into public.subcontractors (id, organization_id, company_id, name, business_name, phone_e164) values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'Mike', 'Mike''s Electric', '+17055550142')
on conflict do nothing;
insert into public.compliance_documents (id, organization_id, company_id, kind, holder_type, issuer, number, expires_on, uploaded_via, status, source_key) values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'liability_insurance', 'company', 'Intact', 'P-4821', '2027-03-31', 'sms', 'current', 'sms:log-1')
on conflict do nothing;
insert into public.compliance_documents (id, organization_id, company_id, kind, holder_type, subcontractor_id, expires_on, uploaded_via, status) values
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'wsib_clearance', 'subcontractor', 'c4000000-0000-4000-8000-000000000001', '2026-11-01', 'sub_link', 'current')
on conflict do nothing;
insert into public.compliance_shares (organization_id, company_id, document_id, token, expires_at) values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now() + interval '7 days')
on conflict do nothing;

do $$
begin
  begin
    insert into public.compliance_documents (organization_id, company_id, kind, holder_type, uploaded_via, status)
    values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'bond', null, 'sms', 'current');
    raise exception 'FAIL a document with no holder that is not pending was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.compliance_documents (organization_id, company_id, kind, holder_type, subcontractor_id, uploaded_via)
    values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'bond', 'company', 'c4000000-0000-4000-8000-000000000001', 'sms');
    raise exception 'FAIL a company document pointing at a sub was accepted';
  exception when check_violation then null;
  end;
  insert into public.compliance_documents (organization_id, company_id, kind, uploaded_via, status)
  values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'other', 'sms', 'pending');
  begin
    insert into public.compliance_documents (organization_id, company_id, kind, holder_type, uploaded_via, source_key)
    values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'bond', 'company', 'sms', 'sms:log-1');
    raise exception 'FAIL the same intake was filed twice';
  exception when unique_violation then null;
  end;
  begin
    insert into public.subcontractors (organization_id, company_id, name, business_name)
    values ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', ' ', null);
    raise exception 'FAIL a sub with no name was accepted';
  exception when check_violation then null;
  end;
  raise notice 'ok   holder rule (pending only without a holder; company docs never point at a sub), one filing per intake, subs need a name';
end $$;

-- An admin of the org reads its documents and subs.
set role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', false);
do $$
begin
  if (select count(*) from public.compliance_documents where company_id = 'c3000000-0000-4000-8000-000000000001') < 2 then
    raise exception 'FAIL an admin cannot read the org''s documents';
  end if;
  if (select count(*) from public.subcontractors) <> 1 then
    raise exception 'FAIL an admin cannot read the org''s subs';
  end if;
  begin
    update public.compliance_documents set expires_on = '2030-01-01' where id = 'c5000000-0000-4000-8000-000000000001';
    raise exception 'FAIL an admin edited a document from the browser';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.compliance_shares;
    raise exception 'FAIL an admin read shared-link tokens from the browser';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok   admin: reads documents and subs; no writes; no shared-link tokens';
end $$;
reset role;

-- A plain member (crew) sees nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', false);
do $$
begin
  if (select count(*) from public.compliance_documents) <> 0 or (select count(*) from public.subcontractors) <> 0 then
    raise exception 'FAIL a plain member can read compliance documents or subs';
  end if;
  raise notice 'ok   member: reads no documents or subs';
end $$;
reset role;

-- Another org's admin sees nothing.
set role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', false);
do $$
begin
  if (select count(*) from public.compliance_documents) <> 0 or (select count(*) from public.subcontractors) <> 0 then
    raise exception 'FAIL another org''s admin can read compliance documents or subs';
  end if;
  raise notice 'ok   another org''s admin: reads nothing';
end $$;
reset role;
