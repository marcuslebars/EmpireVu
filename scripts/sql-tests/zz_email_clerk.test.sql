-- Privilege tests for the Email inbox (Phase 5): 20261014100000_staff_email_clerk.sql.
--   • every new table has RLS on and no client write privilege; anon reads nothing; the digest
--     claim is service-role only;
--   • inboxes, emails and attachments are owner/admin-read only (a member or another org's admin
--     reads nothing);
--   • one inbox per company, unique addresses (lower-case), one row per Message-ID per inbox and
--     per provider id (webhook retries), one attachment row per file, one digest per company per day;
--   • the private bucket.
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['email_inboxes','inbound_emails','email_attachments','email_clerk_digests'];
begin
  raise notice '== email clerk: RLS on, no client writes';
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
  if has_table_privilege('authenticated', 'public.email_clerk_digests', 'SELECT') then
    raise exception 'FAIL authenticated can read email_clerk_digests';
  end if;
  foreach t in array array['email_inboxes','inbound_emails','email_attachments'] loop
    if not exists (select 1 from pg_policies where tablename = t and cmd = 'SELECT' and qual like '%is_organization_admin%') then
      raise exception 'FAIL % is not admin-read only', t;
    end if;
  end loop;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing, digests service-role only', array_length(all_tables, 1);
end $$;

-- ── Fixture: two orgs; a member and an admin in the first, an admin in the second ──────
insert into auth.users (id, email) values
  ('e1000000-0000-4000-8000-000000000001', 'crew@email-clerk.test'),
  ('e1000000-0000-4000-8000-000000000002', 'admin@email-clerk.test'),
  ('e1000000-0000-4000-8000-000000000003', 'other-admin@email-clerk.test')
on conflict do nothing;
insert into public.profiles (id, email, full_name) values
  ('e1000000-0000-4000-8000-000000000001', 'crew@email-clerk.test', 'Mike Crew'),
  ('e1000000-0000-4000-8000-000000000002', 'admin@email-clerk.test', 'Dana Admin'),
  ('e1000000-0000-4000-8000-000000000003', 'other-admin@email-clerk.test', 'Olly Other')
on conflict do nothing;
insert into public.organizations (id, name, slug) values
  ('e2000000-0000-4000-8000-000000000001', 'Email Test', 'email-clerk-test'),
  ('e2000000-0000-4000-8000-000000000002', 'Other Org', 'email-clerk-other')
on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'member'),
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'admin'),
  ('e2000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', 'admin')
on conflict do nothing;
-- Re-runnable on a used database: pin the roles this test relies on.
update public.organization_memberships set role = 'member' where organization_id = 'e2000000-0000-4000-8000-000000000001' and profile_id = 'e1000000-0000-4000-8000-000000000001';
update public.organization_memberships set role = 'admin' where organization_id = 'e2000000-0000-4000-8000-000000000001' and profile_id = 'e1000000-0000-4000-8000-000000000002';
insert into public.companies (id, organization_id, name, slug) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Northshore', 'northshore-email'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'Elsewhere', 'elsewhere-email')
on conflict do nothing;
insert into public.email_inboxes (id, organization_id, company_id, address) values
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'northshore-k3j9x2ab@in.example.test'),
  ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', 'elsewhere-zz9x2abq@in.example.test')
on conflict do nothing;
insert into public.inbound_emails (id, organization_id, company_id, inbox_id, provider_email_id, message_id, from_address, subject, status) values
  ('e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 're_1', '<m1@x.test>', 'dana@x.test', 'Roof quote', 'done'),
  ('e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000002', 're_2', '<m2@x.test>', 'sam@x.test', 'Other', 'done')
on conflict do nothing;
insert into public.email_attachments (organization_id, company_id, inbound_email_id, provider_attachment_id, filename, content_type, storage_path, status) values
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'att_1', 'photo.jpg', 'image/jpeg', 'e2000000-0000-4000-8000-000000000001/e3000000-0000-4000-8000-000000000001/e5000000-0000-4000-8000-000000000001/a.jpg', 'stored')
on conflict do nothing;

-- A member: reads none of it (the customer's mail shows in the inbox through message_log).
set role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000001', false);
do $$
begin
  if (select count(*) from public.email_inboxes) <> 0 then raise exception 'FAIL a member can read inbox addresses'; end if;
  if (select count(*) from public.inbound_emails) <> 0 then raise exception 'FAIL a member can read inbound emails'; end if;
  if (select count(*) from public.email_attachments) <> 0 then raise exception 'FAIL a member can read attachments'; end if;
  raise notice 'ok   member: no inbox address, emails or attachments';
end $$;
do $$
begin
  begin
    update public.inbound_emails set reply_status = 'sent';
    raise exception 'FAIL member updated inbound_emails';
  exception when insufficient_privilege then
    raise notice 'ok   denied: member update inbound_emails';
  end;
end $$;

-- An admin: reads their own org's, not the other org's; still can't write.
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', false);
do $$
begin
  if (select count(*) from public.email_inboxes) <> 1 then raise exception 'FAIL admin sees % inboxes (want 1)', (select count(*) from public.email_inboxes); end if;
  if (select count(*) from public.inbound_emails) <> 1 then raise exception 'FAIL admin sees % emails (want 1)', (select count(*) from public.inbound_emails); end if;
  if (select count(*) from public.email_attachments) <> 1 then raise exception 'FAIL admin sees % attachments (want 1)', (select count(*) from public.email_attachments); end if;
  raise notice 'ok   admin: own org''s inbox, emails and attachments only';
end $$;
do $$
begin
  begin
    insert into public.email_inboxes (organization_id, company_id, address) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'evil-aaaaaaaa@in.example.test');
    raise exception 'FAIL admin inserted an inbox';
  exception when insufficient_privilege then
    raise notice 'ok   denied: admin insert email_inboxes';
  end;
  begin
    update public.email_inboxes set address = 'stolen-aaaaaaaa@in.example.test';
    raise exception 'FAIL admin changed the inbox address';
  exception when insufficient_privilege then
    raise notice 'ok   denied: admin update email_inboxes';
  end;
end $$;
reset role;

-- Constraints.
do $$
begin
  begin
    insert into public.email_inboxes (organization_id, company_id, address) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'second-aaaaaaaa@in.example.test');
    raise exception 'FAIL two inboxes for one company';
  exception when unique_violation then
    raise notice 'ok   one inbox per company';
  end;
  begin
    insert into public.email_inboxes (organization_id, company_id, address) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'Upper-AAAAAAAA@in.example.test');
    raise exception 'FAIL an upper-case address';
  exception when check_violation or unique_violation then
    raise notice 'ok   addresses are lower-case';
  end;
  begin
    insert into public.inbound_emails (organization_id, company_id, inbox_id, provider_email_id, message_id) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 're_other', '<m1@x.test>');
    raise exception 'FAIL the same Message-ID twice in one inbox';
  exception when unique_violation then
    raise notice 'ok   one row per Message-ID per inbox';
  end;
  begin
    insert into public.inbound_emails (organization_id, company_id, inbox_id, provider_email_id, message_id) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 're_1', '<m9@x.test>');
    raise exception 'FAIL the same provider id twice';
  exception when unique_violation then
    raise notice 'ok   one row per provider email id (webhook retries)';
  end;
  begin
    insert into public.inbound_emails (organization_id, company_id, inbox_id, provider_email_id, message_id, category) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 're_bad', '<bad@x.test>', 'invoice_maybe');
    raise exception 'FAIL an unknown category';
  exception when check_violation then
    raise notice 'ok   categories are checked';
  end;
  begin
    insert into public.inbound_emails (organization_id, company_id, inbox_id, provider_email_id, message_id, status) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 're_st', '<st@x.test>', 'zombie');
    raise exception 'FAIL an unknown status';
  exception when check_violation then
    raise notice 'ok   statuses are checked (dead is one)';
  end;
  insert into public.inbound_emails (organization_id, company_id, inbox_id, provider_email_id, message_id, status, attempts, owner_alert_status)
  values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 're_dead', '<dead@x.test>', 'dead', 3, 'sending')
  on conflict do nothing;
  begin
    insert into public.inbound_emails (organization_id, company_id, inbox_id, provider_email_id, message_id) values ('e2000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 're_x', '<x@x.test>');
    raise exception 'FAIL an email under another org''s company';
  exception when foreign_key_violation then
    raise notice 'ok   composite (company, org) key';
  end;
  begin
    insert into public.email_attachments (organization_id, company_id, inbound_email_id, provider_attachment_id, status) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'att_1', 'skipped_type');
    raise exception 'FAIL the same attachment twice';
  exception when unique_violation then
    raise notice 'ok   one row per attachment';
  end;
  begin
    insert into public.email_attachments (organization_id, company_id, inbound_email_id, provider_attachment_id, status) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'att_2', 'stored');
    raise exception 'FAIL a stored attachment without a path';
  exception when check_violation then
    raise notice 'ok   a stored attachment has a path';
  end;
  insert into public.email_clerk_digests (organization_id, company_id, local_date) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', '2026-10-14') on conflict do nothing;
  begin
    insert into public.email_clerk_digests (organization_id, company_id, local_date) values ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', '2026-10-14');
    raise exception 'FAIL two digests in one day';
  exception when unique_violation then
    raise notice 'ok   one digest per company per day';
  end;
  if not exists (select 1 from storage.buckets where id = 'email-attachments' and public = false and file_size_limit = 10485760) then
    raise exception 'FAIL the email-attachments bucket is missing or public';
  end if;
  raise notice 'ok   private email-attachments bucket (10 MB)';
end $$;
