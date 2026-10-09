-- Privilege + trigger tests for 20261009160000_front_desk_hardening.sql. Runs after
-- zz_front_desk_ai.test.sql (file order) and reuses its fixtures (Org A owner a1 / admin a2 /
-- member a3, Brand A). Asserts:
--   • companies.owner_phone_e164 is no longer writable through the session by anyone (owner,
--     admin, member, anon) — only the server's owner-phone route (service role); other profile
--     columns stay writable (the grant was narrowed, not removed);
--   • owner_phone_verified_at is not client-writable either;
--   • the trigger clears owner_phone_verified_at when the number changes, unless the same
--     update re-verifies it; existing numbers were grandfathered as verified;
--   • owner_phone_verifications (codes) is service-role only — not readable by the owner;
--   • the new owner_approvals.notified_to and sms_conversations.recovery_* columns aren't
--     client-writable.

\set ON_ERROR_STOP on
set client_min_messages = warning;
reset role;
update public.companies set owner_phone_e164 = '+17055550142', owner_phone_verified_at = now()
 where id = '00000000-0000-0000-0000-0000000c0a01';
insert into public.owner_phone_verifications (organization_id, company_id, phone_e164, code_hash, expires_at) values
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '+17055551111', 'hash', now() + interval '10 minutes');
set client_min_messages = notice;

do $$ begin raise notice '== hardening: the owner phone is not member-writable'; end $$;
set role authenticated;
set request.jwt.claim.role = 'authenticated';

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1'; -- owner
call sqltest.expect_write_refused('owner sets companies.owner_phone_e164 directly (server route + code only)',
  $$update public.companies set owner_phone_e164 = '+14165550000' where id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner marks the owner phone verified',
  $$update public.companies set owner_phone_verified_at = now() where id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_rows('owner still edits the company name (grant narrowed, not removed)',
  $$update public.companies set name = 'Brand A' where id = '00000000-0000-0000-0000-0000000c0a01'$$, 1);
call sqltest.expect_select_denied('owner reads owner_phone_verifications (codes)', $$select code_hash from public.owner_phone_verifications$$);
call sqltest.expect_write_refused('owner inserts an owner_phone_verifications row',
  $$insert into public.owner_phone_verifications (organization_id, company_id, phone_e164, code_hash, expires_at) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '+1', 'x', now())$$);
call sqltest.expect_write_refused('owner sets owner_approvals.notified_to',
  $$update public.owner_approvals set notified_to = '+14165550000' where id = '00000000-0000-0000-0000-0000000f2a01'$$);
call sqltest.expect_write_refused('owner resets sms_conversations.recovery_attempts',
  $$update public.sms_conversations set recovery_attempts = 0, recovery_alerted_at = null where contact_id = '00000000-0000-0000-0000-0000000f0a01'$$);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2'; -- admin
call sqltest.expect_write_refused('admin sets companies.owner_phone_e164 directly',
  $$update public.companies set owner_phone_e164 = '+14165550000' where id = '00000000-0000-0000-0000-0000000c0a01'$$);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3'; -- member
call sqltest.expect_write_refused('member sets companies.owner_phone_e164 (the old column grant allowed this)',
  $$update public.companies set owner_phone_e164 = '+14165550000' where id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_select_denied('member reads owner_phone_verifications', $$select phone_e164 from public.owner_phone_verifications$$);

reset request.jwt.claim.sub;
set role anon;
call sqltest.expect_write_refused('anon sets companies.owner_phone_e164',
  $$update public.companies set owner_phone_e164 = '+14165550000'$$);
call sqltest.expect_select_denied('anon reads owner_phone_verifications', $$select phone_e164 from public.owner_phone_verifications$$);

reset role;
reset request.jwt.claim.role;

do $$ begin raise notice '== hardening: column privileges'; end $$;
do $$
begin
  if has_column_privilege('authenticated', 'public.companies', 'owner_phone_e164', 'UPDATE') then
    raise exception 'FAIL authenticated still has UPDATE on companies.owner_phone_e164';
  end if;
  if has_column_privilege('authenticated', 'public.companies', 'owner_phone_verified_at', 'UPDATE') then
    raise exception 'FAIL authenticated has UPDATE on companies.owner_phone_verified_at';
  end if;
  if not has_column_privilege('authenticated', 'public.companies', 'owner_email', 'UPDATE') then
    raise exception 'FAIL authenticated lost UPDATE on companies.owner_email (only the phone should go)';
  end if;
  raise notice 'ok   column privileges: owner_phone_e164 / owner_phone_verified_at not member-writable, owner_email still is';
end $$;

do $$ begin raise notice '== hardening: changing the number un-verifies it unless the update re-verifies'; end $$;
do $$
declare
  v timestamptz;
begin
  -- Grandfathered: the fixture's number is verified.
  select owner_phone_verified_at into v from public.companies where id = '00000000-0000-0000-0000-0000000c0a01';
  if v is null then raise exception 'FAIL fixture owner phone should be verified'; end if;
  -- A change without re-verifying (e.g. an operator tool that forgot) clears it.
  update public.companies set owner_phone_e164 = '+17055559876' where id = '00000000-0000-0000-0000-0000000c0a01';
  select owner_phone_verified_at into v from public.companies where id = '00000000-0000-0000-0000-0000000c0a01';
  if v is not null then raise exception 'FAIL a changed owner phone kept owner_phone_verified_at'; end if;
  -- The code-confirmed path sets both in one update: kept.
  update public.companies set owner_phone_e164 = '+17055551111', owner_phone_verified_at = now() where id = '00000000-0000-0000-0000-0000000c0a01';
  select owner_phone_verified_at into v from public.companies where id = '00000000-0000-0000-0000-0000000c0a01';
  if v is null then raise exception 'FAIL a re-verified owner phone lost owner_phone_verified_at'; end if;
  -- Unrelated updates leave it alone.
  update public.companies set name = 'Brand A' where id = '00000000-0000-0000-0000-0000000c0a01';
  select owner_phone_verified_at into v from public.companies where id = '00000000-0000-0000-0000-0000000c0a01';
  if v is null then raise exception 'FAIL an unrelated update cleared owner_phone_verified_at'; end if;
  raise notice 'ok   trigger: change → unverified; change + verify → verified; other updates → unchanged';
end $$;

do $$ begin raise notice '== hardening: privilege tests passed'; end $$;
