-- Privilege tests for 20261009120000_invoice_opens_reminders.sql.
--
-- Runs after lock_privileged_columns.test.sql (fixtures + sqltest.* helpers). Staff may
-- pause one invoice's reminders; the open counters and the functions that bump them are
-- server-only (service role).

\set ON_ERROR_STOP on
set client_min_messages = warning;

reset role;
insert into public.invoices (id, organization_id, company_id, contact_id, public_token, status, total_cents, subtotal_cents, balance_due_cents) values
  ('00000000-0000-0000-0000-00000000e0c1', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c7a01', 'tok-opens', 'sent', 10000, 10000, 10000)
on conflict do nothing;

set role authenticated;
set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3'; -- plain member of Org A

call sqltest.expect_rows('member pauses one invoice''s reminders',
  $$update public.invoices set reminders_paused = true where id = '00000000-0000-0000-0000-00000000e0c1'$$, 1);
call sqltest.expect_denied('member sets invoices.view_count',
  $$update public.invoices set view_count = 99 where id = '00000000-0000-0000-0000-00000000e0c1'$$);
call sqltest.expect_denied('member sets invoices.email_open_count',
  $$update public.invoices set email_open_count = 99 where id = '00000000-0000-0000-0000-00000000e0c1'$$);
call sqltest.expect_denied('member sets invoices.last_viewed_at',
  $$update public.invoices set last_viewed_at = now() where id = '00000000-0000-0000-0000-00000000e0c1'$$);
call sqltest.expect_denied('member calls record_invoice_view',
  $$select * from public.record_invoice_view('00000000-0000-0000-0000-00000000e0c1')$$);
call sqltest.expect_denied('member calls record_invoice_email_open',
  $$select * from public.record_invoice_email_open('00000000-0000-0000-0000-00000000e0c1')$$);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1'; -- owner of Org B
call sqltest.expect_rows('another org can''t pause Org A''s reminders (RLS: 0 rows)',
  $$update public.invoices set reminders_paused = false where id = '00000000-0000-0000-0000-00000000e0c1'$$, 0);

reset role;
reset request.jwt.claim.role;
set role anon;
call sqltest.expect_denied('anon calls record_invoice_view',
  $$select * from public.record_invoice_view('00000000-0000-0000-0000-00000000e0c1')$$);

-- The server's own path: counts once inside the dedupe window, says which was first,
-- never counts a draft or void invoice.
reset role;
set role service_role;
set request.jwt.claim.role = 'service_role';
do $$
declare r record;
begin
  select * into r from public.record_invoice_view('00000000-0000-0000-0000-00000000e0c1', 1800);
  if not (r.counted and r.first_view and r.view_count = 1) then raise exception 'first view: %', r; end if;
  select * into r from public.record_invoice_view('00000000-0000-0000-0000-00000000e0c1', 1800);
  if r.counted or r.view_count <> 1 then raise exception 'refresh counted again: %', r; end if;
  if (select status from public.invoices where id = '00000000-0000-0000-0000-00000000e0c1') <> 'sent' then
    raise exception 'the counter itself must not change the status (refresh_invoice_balance does)';
  end if;
  select * into r from public.record_invoice_email_open('00000000-0000-0000-0000-00000000e0c1', 1800);
  if not (r.counted and r.first_open and r.open_count = 1) then raise exception 'email open: %', r; end if;
  select * into r from public.record_invoice_view('00000000-0000-0000-0000-00000000e0b1', 1800); -- Org B draft
  if r.counted then raise exception 'a draft was counted'; end if;
  if (select reminders_paused from public.invoices where id = '00000000-0000-0000-0000-00000000e0c1') is not true then
    raise exception 'member''s pause did not stick';
  end if;
  raise notice 'ok   service_role counts opens once per window; drafts never';
end $$;
reset role;
reset request.jwt.claim.role;
reset request.jwt.claim.sub;
