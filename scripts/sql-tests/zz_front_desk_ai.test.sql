-- Privilege tests for the AI front desk (Phase 1): 20261009100000 … 20261009150000.
--
-- Runs after zz_done_for_you.test.sql (file order) and reuses its sqltest helpers and fixture
-- users / orgs / companies (re-inserted with ON CONFLICT DO NOTHING). Asserts:
--   • sms_conversations / owner_approvals / weekly_report_sends and the new columns
--     (companies.ai_settings, message_log.media / sent_by, sms_conversations.lock_*,
--     owner_approvals.execution_claimed_at / short_code / status, missed_calls.ai_*) are NOT
--     client-writable by owners, admins, members or anon;
--   • owner_command_log, platform_sms_opt_outs and call_answering_notices are NOT client-readable
--     (service role only) — not even by the org's owner;
--   • members still read their own org's conversations / approvals / weekly sends, never another
--     org's; anon reads none of it.

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

insert into public.contacts (id, organization_id, company_id, first_name, phone) values
  ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'Jamie', '+17055550123')
on conflict do nothing;
insert into public.sms_conversations (id, organization_id, company_id, contact_id, state) values
  ('00000000-0000-0000-0000-0000000f1a01', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000f0a01', 'ai')
on conflict do nothing;
insert into public.owner_approvals (id, organization_id, company_id, contact_id, kind, summary, short_code) values
  ('00000000-0000-0000-0000-0000000f2a01', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000f0a01', 'custom_price', 'Jamie asks $500', 1)
on conflict do nothing;
insert into public.weekly_report_sends (organization_id, company_id, week_start, status) values
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '2026-10-05', 'sent')
on conflict do nothing;
insert into public.owner_command_log (organization_id, company_id, from_phone, body, intent) values
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '+17055550142', 'move Jamie to Friday 9', 'command');
insert into public.platform_sms_opt_outs (phone_e164, opted_out_at) values ('+17055550142', now()) on conflict do nothing;
insert into public.call_answering_notices (organization_id, company_id, month, kind) values
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '2026-10-01', 'minutes_exhausted')
on conflict do nothing;
insert into public.message_log (id, organization_id, company_id, contact_id, channel, direction, status, body, sent_by) values
  ('00000000-0000-0000-0000-0000000f3a01', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000f0a01', 'sms', 'outbound', 'sent', 'Hi, it''s Brand A''s automated assistant.', 'sms_agent')
on conflict do nothing;
insert into public.missed_calls (organization_id, company_id, call_sid, from_number, to_number, text_back_status) values
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'CA-sqltest-1', '+17055550177', '+17055550151', 'ai_handled')
on conflict do nothing;

set client_min_messages = notice;

-- ═════════════════════════════════════════════════════════════════════════════
do $$ begin raise notice '== AI front desk: client writes'; end $$;
set role authenticated;
set request.jwt.claim.role = 'authenticated';

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1'; -- owner
call sqltest.expect_write_refused('owner writes companies.ai_settings directly (only the ai-settings routes may)',
  $$update public.companies set ai_settings = '{"sms_agent":{"enabled":false}}'::jsonb where id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner flips sms_conversations.state',
  $$update public.sms_conversations set state = 'owner' where contact_id = '00000000-0000-0000-0000-0000000f0a01'$$);
call sqltest.expect_write_refused('owner takes the turn lease (sms_conversations.lock_until)',
  $$update public.sms_conversations set lock_until = now() + interval '1 hour', lock_token = gen_random_uuid() where contact_id = '00000000-0000-0000-0000-0000000f0a01'$$);
call sqltest.expect_write_refused('owner inserts an sms_conversations row',
  $$insert into public.sms_conversations (organization_id, company_id, contact_id) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000f0a01')$$);
call sqltest.expect_write_refused('owner approves owner_approvals directly (must go through the decide route)',
  $$update public.owner_approvals set status = 'approved' where id = '00000000-0000-0000-0000-0000000f2a01'$$);
call sqltest.expect_write_refused('owner clears owner_approvals.execution_claimed_at',
  $$update public.owner_approvals set execution_claimed_at = null, short_code = 9 where id = '00000000-0000-0000-0000-0000000f2a01'$$);
call sqltest.expect_write_refused('owner inserts an owner_approvals row',
  $$insert into public.owner_approvals (organization_id, company_id, kind, summary) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'send_reply', 'x')$$);
call sqltest.expect_write_refused('owner rewrites weekly_report_sends',
  $$update public.weekly_report_sends set status = 'failed' where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('owner relabels message_log.sent_by',
  $$update public.message_log set sent_by = null where id = '00000000-0000-0000-0000-0000000f3a01'$$);
call sqltest.expect_write_refused('owner writes message_log.media',
  $$update public.message_log set media = '[]'::jsonb where id = '00000000-0000-0000-0000-0000000f3a01'$$);
call sqltest.expect_write_refused('owner resets missed_calls AI state',
  $$update public.missed_calls set text_back_status = 'pending', ai_followup_at = null where call_sid = 'CA-sqltest-1'$$);
call sqltest.expect_write_refused('owner writes owner_command_log',
  $$insert into public.owner_command_log (from_phone, body) values ('+1', 'x')$$);
call sqltest.expect_write_refused('owner clears a platform opt-out',
  $$delete from public.platform_sms_opt_outs where phone_e164 = '+17055550142'$$);
call sqltest.expect_write_refused('owner deletes the minutes-notice claim',
  $$delete from public.call_answering_notices where company_id = '00000000-0000-0000-0000-0000000c0a01'$$);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2'; -- admin
call sqltest.expect_write_refused('admin writes companies.ai_settings',
  $$update public.companies set ai_settings = '{}'::jsonb where id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_write_refused('admin deletes owner_approvals',
  $$delete from public.owner_approvals where id = '00000000-0000-0000-0000-0000000f2a01'$$);
call sqltest.expect_write_refused('admin updates sms_conversations.collected',
  $$update public.sms_conversations set collected = '{}'::jsonb where contact_id = '00000000-0000-0000-0000-0000000f0a01'$$);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3'; -- member
call sqltest.expect_write_refused('member updates sms_conversations.state',
  $$update public.sms_conversations set state = 'paused' where contact_id = '00000000-0000-0000-0000-0000000f0a01'$$);
call sqltest.expect_write_refused('member inserts weekly_report_sends',
  $$insert into public.weekly_report_sends (organization_id, company_id, week_start) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '2026-10-12')$$);

-- ═════════════════════════════════════════════════════════════════════════════
do $$ begin raise notice '== AI front desk: service-role-only tables are not client-readable'; end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1'; -- owner
call sqltest.expect_select_denied('owner reads owner_command_log', $$select body from public.owner_command_log$$);
call sqltest.expect_select_denied('owner reads platform_sms_opt_outs', $$select phone_e164 from public.platform_sms_opt_outs$$);
call sqltest.expect_select_denied('owner reads call_answering_notices', $$select month from public.call_answering_notices$$);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3'; -- member
call sqltest.expect_select_denied('member reads owner_command_log', $$select body from public.owner_command_log$$);
call sqltest.expect_select_denied('member reads platform_sms_opt_outs', $$select phone_e164 from public.platform_sms_opt_outs$$);
call sqltest.expect_select_denied('member reads call_answering_notices', $$select month from public.call_answering_notices$$);

do $$ begin raise notice '== AI front desk: member reads stay org-scoped'; end $$;
call sqltest.expect_select_rows('member reads own org sms_conversations', $$select state from public.sms_conversations$$, 1);
call sqltest.expect_select_rows('member reads own org owner_approvals', $$select summary from public.owner_approvals$$, 1);
call sqltest.expect_select_rows('member reads own org weekly_report_sends', $$select status from public.weekly_report_sends$$, 1);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1'; -- other org's owner
call sqltest.expect_select_rows('Org B owner sees none of Org A''s conversations', $$select state from public.sms_conversations$$, 0);
call sqltest.expect_select_rows('Org B owner sees none of Org A''s approvals', $$select summary from public.owner_approvals$$, 0);
call sqltest.expect_select_rows('Org B owner sees none of Org A''s weekly sends', $$select status from public.weekly_report_sends$$, 0);
call sqltest.expect_write_refused('Org B owner approves Org A''s approval',
  $$update public.owner_approvals set status = 'approved' where id = '00000000-0000-0000-0000-0000000f2a01'$$);

reset request.jwt.claim.sub;
set role anon;
call sqltest.expect_select_denied('anon reads sms_conversations', $$select state from public.sms_conversations$$);
call sqltest.expect_select_denied('anon reads owner_approvals', $$select summary from public.owner_approvals$$);
call sqltest.expect_select_denied('anon reads weekly_report_sends', $$select status from public.weekly_report_sends$$);
call sqltest.expect_select_denied('anon reads owner_command_log', $$select body from public.owner_command_log$$);
call sqltest.expect_select_denied('anon reads platform_sms_opt_outs', $$select phone_e164 from public.platform_sms_opt_outs$$);
call sqltest.expect_select_denied('anon reads call_answering_notices', $$select month from public.call_answering_notices$$);
call sqltest.expect_write_refused('anon writes sms_conversations',
  $$update public.sms_conversations set state = 'closed'$$);

reset role;
reset request.jwt.claim.role;
do $$ begin raise notice '== AI front desk: privilege tests passed'; end $$;
