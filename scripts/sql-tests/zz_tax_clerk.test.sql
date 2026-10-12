-- Privilege tests for the Tax Clerk (Phase 4): 20261013100000_staff_tax_clerk.sql.
--   • every new table has RLS on and no client write; anon reads nothing; tax_clerk_notices is
--     service-role only; receipt_texts and hst_periods are owner/admin-read only (a crew member
--     sees no rows, an owner sees their org's);
--   • the checks hold: one row per texted picture (log id + media index), one HST row per company
--     period, a PO reference looks like PO-<n>, receipt files are jpeg / pdf only;
--   • expenses and the expense-receipts bucket are unchanged (jpeg / pdf only).
\set ON_ERROR_STOP on
set client_min_messages = notice;
reset role;

do $$
declare
  t text;
  r text;
  p text;
  all_tables text[] := array['receipt_texts','hst_periods','tax_clerk_notices'];
begin
  raise notice '== tax clerk: RLS on, no client writes';
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
  if has_table_privilege('authenticated', 'public.tax_clerk_notices', 'SELECT') then
    raise exception 'FAIL authenticated can read tax_clerk_notices';
  end if;
  foreach t in array array['receipt_texts','hst_periods'] loop
    if not exists (select 1 from pg_policies where tablename = t and cmd = 'SELECT' and qual like '%is_organization_admin%') then
      raise exception 'FAIL % is not admin-read only', t;
    end if;
    if exists (select 1 from pg_policies where tablename = t and cmd <> 'SELECT') then
      raise exception 'FAIL % has a client write policy', t;
    end if;
  end loop;
  if (select allowed_mime_types from storage.buckets where id = 'expense-receipts') is distinct from array['image/jpeg', 'application/pdf'] then
    raise exception 'FAIL expense-receipts bucket types changed';
  end if;
  raise notice 'ok   % tables: RLS on, no client insert/update/delete, anon reads nothing, notices service-role only', array_length(all_tables, 1);
end $$;

-- Fixture: an org with an owner and a crew member, a company, one texted receipt and one HST period.
insert into auth.users (id, email) values
  ('b1000000-0000-4000-8000-000000000001', 'owner@taxclerk.test'),
  ('b1000000-0000-4000-8000-000000000002', 'crew@taxclerk.test')
on conflict do nothing;
insert into public.profiles (id, email, full_name) values
  ('b1000000-0000-4000-8000-000000000001', 'owner@taxclerk.test', 'Dana Owner'),
  ('b1000000-0000-4000-8000-000000000002', 'crew@taxclerk.test', 'Mike Crew')
on conflict do nothing;
insert into public.organizations (id, name, slug) values ('b2000000-0000-4000-8000-000000000001', 'Tax Clerk Test', 'tax-clerk-test') on conflict do nothing;
insert into public.organization_memberships (organization_id, profile_id, role) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'owner'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'member')
on conflict do nothing;
insert into public.companies (id, organization_id, name, slug) values ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Northshore', 'northshore-taxclerk') on conflict do nothing;
insert into public.receipt_texts (id, organization_id, company_id, log_id, media_index, status, vendor, amount_cents, po_reference)
values ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 0, 'needs_review', 'Home Depot', null, 'PO-12')
on conflict do nothing;
insert into public.hst_periods (id, organization_id, company_id, frequency, period_start, period_end, due_date, payment_due_date, label)
values ('b6000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'quarterly', '2026-07-01', '2026-09-30', '2026-10-31', '2026-10-31', 'Q3')
on conflict do nothing;

do $$
begin
  begin
    insert into public.receipt_texts (organization_id, company_id, log_id, media_index)
    values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 0);
    raise exception 'FAIL the same picture was claimed twice';
  exception when unique_violation then null;
  end;
  begin
    insert into public.hst_periods (organization_id, company_id, frequency, period_start, period_end, due_date, payment_due_date, label)
    values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'quarterly', '2026-07-01', '2026-09-30', '2026-10-31', '2026-10-31', 'Q3');
    raise exception 'FAIL the same HST period was claimed twice';
  exception when unique_violation then null;
  end;
  begin
    update public.receipt_texts set po_reference = 'PO 12; drop' where id = 'b4000000-0000-4000-8000-000000000001';
    raise exception 'FAIL a malformed PO reference was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.receipt_texts set file_type = 'image/png', file_path = 'x' where id = 'b4000000-0000-4000-8000-000000000001';
    raise exception 'FAIL a png receipt file was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.receipt_texts (organization_id, company_id, log_id, media_index)
    values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002', 0);
    insert into public.tax_clerk_notices (organization_id, company_id, kind, key) values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'weekly_nudge', '2026-10-19');
    insert into public.tax_clerk_notices (organization_id, company_id, kind, key) values ('b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'weekly_nudge', '2026-10-19');
    raise exception 'FAIL the same Monday nudge was claimed twice';
  exception when unique_violation then null;
  end;
  raise notice 'ok   one claim per picture / HST period / nudge; PO references and file types checked';
end $$;

-- A crew member sees nothing; the owner sees their org's rows; nobody writes through a session.
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', false);
do $$
begin
  if exists (select 1 from public.receipt_texts) or exists (select 1 from public.hst_periods) then
    raise exception 'FAIL a crew member can read receipt_texts / hst_periods';
  end if;
  raise notice 'ok   denied: a crew member reads no texted receipts or HST periods';
end $$;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', false);
do $$
begin
  if not exists (select 1 from public.receipt_texts where id = 'b4000000-0000-4000-8000-000000000001')
     or not exists (select 1 from public.hst_periods where id = 'b6000000-0000-4000-8000-000000000001') then
    raise exception 'FAIL the owner cannot read their texted receipts / HST periods';
  end if;
  raise notice 'ok   allowed: the owner reads their texted receipts and HST periods';
  begin
    update public.receipt_texts set status = 'filed' where id = 'b4000000-0000-4000-8000-000000000001';
    raise exception 'FAIL the owner updated receipt_texts through a session';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.hst_periods set packet_emailed_to = 'x@y.z' where id = 'b6000000-0000-4000-8000-000000000001';
    raise exception 'FAIL the owner updated hst_periods through a session';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok   denied: writing receipt_texts / hst_periods through a session (owner)';
end $$;
reset role;
