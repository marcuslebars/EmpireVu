-- Privilege tests for 20261006170000_lock_privileged_columns.sql.
--
-- Acts as PostgREST does: `set role authenticated` + the JWT `sub` claim in
-- request.jwt.claim.sub (auth.uid() reads it). Every check is an assertion: a write that
-- must be refused has to fail with insufficient_privilege (42501, column grants and guard
-- triggers) or a row-level-security violation, and a write the app relies on has to
-- succeed. Any wrong outcome raises and stops the run (psql ON_ERROR_STOP).
--
-- Run with scripts/sql-tests/run.sh (applies every migration to a throwaway database
-- first). Leaves its fixture rows in that throwaway database.

\set ON_ERROR_STOP on
set client_min_messages = warning;

-- ── fixtures (as the table owner) ────────────────────────────────────────────
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
  ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-00000000aaaa', 'Brand A', 'brand-a')
on conflict do nothing;

insert into public.contacts (id, organization_id, company_id, first_name) values
  ('00000000-0000-0000-0000-0000000c7a01', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'Pat')
on conflict do nothing;

insert into public.quotes (id, organization_id, company_id, contact_id, public_token, status, total_cents, deposit_cents) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c7a01', 'tok-q1', 'sent', 100000, 25000)
on conflict do nothing;

insert into public.invoices (id, organization_id, company_id, contact_id, public_token, status, total_cents, subtotal_cents, balance_due_cents) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c7a01', 'tok-i1', 'sent', 50000, 50000, 50000)
on conflict do nothing;

insert into public.bookings (id, organization_id, company_id, contact_id, title, scheduled_for, deposit_cents) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c7a01', 'Haul-out', now() + interval '3 days', 10000)
on conflict do nothing;

insert into public.companies (id, organization_id, name, slug) values
  ('00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000bbbb', 'Brand B', 'brand-b')
on conflict do nothing;
insert into public.invoices (id, organization_id, company_id, public_token, status, total_cents, subtotal_cents, balance_due_cents) values
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-0000000c0b01', 'tok-ib', 'draft', 100, 100, 100)
on conflict do nothing;

-- ── assertion helpers ────────────────────────────────────────────────────────
-- expect_denied: the statement must raise insufficient_privilege / RLS violation.
create schema if not exists sqltest;
grant usage on schema sqltest to anon, authenticated, service_role;

create or replace procedure sqltest.expect_denied(label text, stmt text)
language plpgsql as $$
begin
  begin
    execute stmt;
  exception
    when insufficient_privilege then
      raise notice 'ok   denied: %', label;
      return;
    when others then
      if sqlerrm like '%row-level security%' then
        raise notice 'ok   denied (RLS): %', label;
        return;
      end if;
      raise exception 'FAIL % — expected a privilege error, got % (%)', label, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL % — write was ALLOWED but must be denied', label;
end $$;

-- expect_rows: the statement must succeed and touch exactly n rows.
create or replace procedure sqltest.expect_rows(label text, stmt text, n integer)
language plpgsql as $$
declare
  got integer;
begin
  execute stmt;
  get diagnostics got = row_count;
  if got <> n then
    raise exception 'FAIL % — expected % row(s), got %', label, n, got;
  end if;
  raise notice 'ok   allowed: %', label;
end $$;

-- expect_blocked: refused either way — a privilege/RLS error, or RLS hides the row (0 rows).
create or replace procedure sqltest.expect_blocked(label text, stmt text)
language plpgsql as $$
declare
  got integer;
begin
  begin
    execute stmt;
    get diagnostics got = row_count;
  exception
    when insufficient_privilege then
      raise notice 'ok   denied: %', label;
      return;
    when others then
      if sqlerrm like '%row-level security%' then
        raise notice 'ok   denied (RLS): %', label;
        return;
      end if;
      raise exception 'FAIL % — expected a privilege error, got % (%)', label, sqlstate, sqlerrm;
  end;
  if got <> 0 then
    raise exception 'FAIL % — write was ALLOWED (% rows) but must be refused', label, got;
  end if;
  raise notice 'ok   no effect (RLS hides the row): %', label;
end $$;

grant execute on all procedures in schema sqltest to anon, authenticated, service_role;

set client_min_messages = notice;

-- ═════════════════════════════════════════════════════════════════════════════
-- Org ADMIN (not owner) of Org A
-- ═════════════════════════════════════════════════════════════════════════════
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
set request.jwt.claim.role = 'authenticated';

-- The reported bug: billing columns on the admin's own org.
call sqltest.expect_denied('admin sets organizations.plan = internal',
  $$update public.organizations set plan = 'internal' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('admin sets organizations.subscription_status',
  $$update public.organizations set subscription_status = 'active' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('admin sets organizations.trial_ends_at',
  $$update public.organizations set trial_ends_at = now() + interval '10 years' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('admin sets organizations.crankleads_tier',
  $$update public.organizations set crankleads_tier = 'front_desk' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('admin sets organizations.stripe_customer_id',
  $$update public.organizations set stripe_customer_id = 'cus_someone_else' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('admin sets organizations.billing_email',
  $$update public.organizations set billing_email = 'x@y.test' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('admin sets organizations.created_by',
  $$update public.organizations set created_by = '00000000-0000-0000-0000-0000000000a2' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('admin creates an org with plan = internal',
  $$insert into public.organizations (name, slug, plan, created_by) values ('Free', 'free-ride', 'internal', '00000000-0000-0000-0000-0000000000a2')$$);

-- What the app's Settings → Organization does (PATCH /api/organizations/:id).
call sqltest.expect_rows('admin renames the org (name, slug)',
  $$update public.organizations set name = 'Org A Renamed', slug = 'org-a-renamed' where id = '00000000-0000-0000-0000-00000000aaaa'$$, 1);

-- Admin may not grant or take away ownership, or make themselves owner.
call sqltest.expect_denied('admin promotes themselves to owner',
  $$update public.organization_memberships set role = 'owner' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a2'$$);
call sqltest.expect_denied('admin makes a member an owner',
  $$update public.organization_memberships set role = 'owner' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a3'$$);
call sqltest.expect_denied('admin demotes the owner',
  $$update public.organization_memberships set role = 'member' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a1'$$);
call sqltest.expect_denied('admin removes the owner',
  $$delete from public.organization_memberships where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a1'$$);
call sqltest.expect_denied('admin moves a membership to another org',
  $$update public.organization_memberships set organization_id = '00000000-0000-0000-0000-00000000bbbb' where profile_id = '00000000-0000-0000-0000-0000000000a3'$$);
call sqltest.expect_denied('admin inserts a membership directly',
  $$insert into public.organization_memberships (organization_id, profile_id, role) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000000b1', 'admin')$$);
-- …but may manage members (Settings → Team).
call sqltest.expect_rows('admin makes a member an admin',
  $$update public.organization_memberships set role = 'admin' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a3'$$, 1);
call sqltest.expect_rows('admin makes them a member again',
  $$update public.organization_memberships set role = 'member' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a3'$$, 1);

-- Invitations: admins invite admins/members; nobody invites an owner.
call sqltest.expect_denied('admin invites an OWNER',
  $$insert into public.organization_invitations (organization_id, email, role, token, invited_by_profile_id) values ('00000000-0000-0000-0000-00000000aaaa', 'boss@x.test', 'owner', 'tok-owner', '00000000-0000-0000-0000-0000000000a2')$$);
call sqltest.expect_rows('admin invites a member',
  $$insert into public.organization_invitations (organization_id, email, role, token, invited_by_profile_id) values ('00000000-0000-0000-0000-00000000aaaa', 'new@x.test', 'member', 'tok-member', '00000000-0000-0000-0000-0000000000a2')$$, 1);
call sqltest.expect_denied('admin flips an invitation to owner',
  $$update public.organization_invitations set role = 'owner' where token = 'tok-member'$$);
call sqltest.expect_denied('admin marks an invitation accepted',
  $$update public.organization_invitations set status = 'accepted' where token = 'tok-member'$$);
call sqltest.expect_rows('admin revokes an invitation',
  $$update public.organization_invitations set status = 'revoked' where token = 'tok-member'$$, 1);

-- Companies: Stripe Connect mirror is server-only; profile/settings fields are not.
call sqltest.expect_denied('admin sets companies.stripe_charges_enabled',
  $$update public.companies set stripe_charges_enabled = true where id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_denied('admin sets companies.stripe_connected_account_id',
  $$update public.companies set stripe_connected_account_id = 'acct_123' where id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_denied('admin sets companies.quote_public_base_url',
  $$update public.companies set quote_public_base_url = 'https://evil.test' where id = '00000000-0000-0000-0000-0000000c0a01'$$);
call sqltest.expect_denied('admin creates a company with a Stripe account',
  $$insert into public.companies (organization_id, name, slug, stripe_connected_account_id) values ('00000000-0000-0000-0000-00000000aaaa', 'X', 'x', 'acct_999')$$);
call sqltest.expect_rows('admin updates business profile + settings',
  $$update public.companies set name = 'Brand A2', brand_primary_color = '#112233', invoice_settings = '{}'::jsonb, online_booking_settings = '{}'::jsonb, updated_at = now() where id = '00000000-0000-0000-0000-0000000c0a01'$$, 1);
call sqltest.expect_rows('admin creates a company (name/slug/website/notes)',
  $$insert into public.companies (organization_id, name, slug, website, notes, created_by) values ('00000000-0000-0000-0000-00000000aaaa', 'Brand Z', 'brand-z', 'https://z.test', 'n', '00000000-0000-0000-0000-0000000000a2')$$, 1);

-- Billing mirrors / entitlement tables: no client writes at all.
call sqltest.expect_denied('admin inserts a subscriptions row',
  $$insert into public.subscriptions (organization_id, stripe_subscription_id, plan, status) values ('00000000-0000-0000-0000-00000000aaaa', 'sub_x', 'front_desk', 'active')$$);
call sqltest.expect_denied('admin inserts a feature_flags override',
  $$insert into public.feature_flags (organization_id, feature, enabled) values ('00000000-0000-0000-0000-00000000aaaa', 'marina_reception', true)$$);
call sqltest.expect_denied('admin deletes usage_events (resets the cap)',
  $$delete from public.usage_events where organization_id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('admin calls record_billing_event (forged Stripe event)',
  $$select public.record_billing_event('evt_forged', 'checkout.session.completed', '{}'::jsonb, null)$$);
call sqltest.expect_denied('admin calls claim_billing_event_jobs',
  $$select * from public.claim_billing_event_jobs('x', 10, 900)$$);
call sqltest.expect_denied('admin calls claim_workflow_event_jobs',
  $$select * from public.claim_workflow_event_jobs('x', 10, 900)$$);
call sqltest.expect_denied('admin calls consume_rate_limit',
  $$select public.consume_rate_limit('k', 1, 60)$$);
call sqltest.expect_denied('admin advances ANOTHER org''s quote counter',
  $$select public.next_quote_number('00000000-0000-0000-0000-00000000bbbb')$$);

-- ═════════════════════════════════════════════════════════════════════════════
-- Plain MEMBER of Org A — quotes, invoices, payments, bookings, self-promotion
-- ═════════════════════════════════════════════════════════════════════════════
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';

call sqltest.expect_blocked('member promotes themselves to admin',
  $$update public.organization_memberships set role = 'admin' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a3'$$);
call sqltest.expect_blocked('member promotes themselves to owner',
  $$update public.organization_memberships set role = 'owner' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a3'$$);
-- name is a granted column, so a non-admin is stopped by RLS (0 rows), not by a privilege.
call sqltest.expect_rows('member renames the org (RLS: 0 rows)',
  $$update public.organizations set name = 'nope' where id = '00000000-0000-0000-0000-00000000aaaa'$$, 0);
call sqltest.expect_denied('member sets organizations.plan',
  $$update public.organizations set plan = 'internal' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('member invites someone (admins only)',
  $$insert into public.organization_invitations (organization_id, email, role, token, invited_by_profile_id) values ('00000000-0000-0000-0000-00000000aaaa', 'friend@x.test', 'admin', 'tok-friend', '00000000-0000-0000-0000-0000000000a3')$$);
call sqltest.expect_denied('member changes their profile email',
  $$update public.profiles set email = 'owner@b.test' where id = '00000000-0000-0000-0000-0000000000a3'$$);
call sqltest.expect_rows('member edits their own name',
  $$update public.profiles set full_name = 'Member Three' where id = '00000000-0000-0000-0000-0000000000a3'$$, 1);

-- Quotes: the customer's approval is server-only.
call sqltest.expect_denied('member sets quotes.status = approved',
  $$update public.quotes set status = 'approved' where id = '00000000-0000-0000-0000-00000000f001'$$);
call sqltest.expect_denied('member writes the approval snapshot',
  $$update public.quotes set approved_at = now(), approved_total_cents = 1, approved_line_items = '[]'::jsonb where id = '00000000-0000-0000-0000-00000000f001'$$);
call sqltest.expect_denied('member sets quotes.deposit_paid_at',
  $$update public.quotes set deposit_paid_at = now() where id = '00000000-0000-0000-0000-00000000f001'$$);
call sqltest.expect_denied('member sets quotes.status = deposit_paid',
  $$update public.quotes set status = 'deposit_paid' where id = '00000000-0000-0000-0000-00000000f001'$$);
call sqltest.expect_denied('member creates a quote already approved',
  $$insert into public.quotes (organization_id, company_id, public_token, status) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'tok-q2', 'approved')$$);
call sqltest.expect_rows('member creates a draft quote',
  $$insert into public.quotes (organization_id, company_id, contact_id, public_token, status, title, line_items, subtotal_cents, tax_cents, total_cents, deposit_cents, tax_rate_bps, deposit_rate_bps, input_snapshot, expires_at, auto_generated, created_by) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c7a01', 'tok-q3', 'draft', 'Detail', '[]'::jsonb, 1000, 130, 1130, 0, 1300, 0, '{}'::jsonb, now() + interval '30 days', false, '00000000-0000-0000-0000-0000000000a3')$$, 1);
call sqltest.expect_rows('member re-prices the draft',
  $$update public.quotes set total_cents = 2260, subtotal_cents = 2000, tax_cents = 260, notes = 'x' where public_token = 'tok-q3'$$, 1);
call sqltest.expect_rows('member sends the draft (draft → sent)',
  $$update public.quotes set status = 'sent', quote_number = 'Q-2026-0001', sent_at = now(), valid_until = now() + interval '30 days' where public_token = 'tok-q3'$$, 1);
call sqltest.expect_rows('member voids a sent quote (→ cancelled)',
  $$update public.quotes set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Voided' where public_token = 'tok-q3'$$, 1);
call sqltest.expect_rows('member allocates a quote number for their own org',
  $$select public.next_quote_number('00000000-0000-0000-0000-00000000aaaa')$$, 1);

-- Invoices: paid / balance / Stripe columns are derived by the server.
call sqltest.expect_denied('member marks an invoice paid',
  $$update public.invoices set status = 'paid', paid_at = now() where id = '00000000-0000-0000-0000-00000000e001'$$);
call sqltest.expect_denied('member sets invoices.amount_paid_cents',
  $$update public.invoices set amount_paid_cents = 50000 where id = '00000000-0000-0000-0000-00000000e001'$$);
call sqltest.expect_denied('member creates an invoice already paid',
  $$insert into public.invoices (organization_id, company_id, public_token, status, total_cents) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', 'tok-i2', 'paid', 100)$$);
call sqltest.expect_rows('member edits an unpaid sent invoice',
  $$update public.invoices set title = 'Spring work', notes = 'thanks', due_date = current_date + 30 where id = '00000000-0000-0000-0000-00000000e001'$$, 1);
do $$
begin
  -- A forged balance is overwritten with the derived one.
  update public.invoices set balance_due_cents = 1 where id = '00000000-0000-0000-0000-00000000e001';
  if (select balance_due_cents from public.invoices where id = '00000000-0000-0000-0000-00000000e001') <> 50000 then
    raise exception 'FAIL balance_due_cents was not re-derived';
  end if;
  raise notice 'ok   balance_due_cents is re-derived, not typed in';
end $$;

-- Payments: offline money only, capped at what's owing; Stripe rows are webhook-only.
call sqltest.expect_denied('member records a payment larger than the balance',
  $$insert into public.invoice_payments (organization_id, company_id, invoice_id, amount_cents, method, status) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-00000000e001', 999999, 'cash', 'succeeded')$$);
call sqltest.expect_denied('member records a payment with a Stripe intent id',
  $$insert into public.invoice_payments (organization_id, company_id, invoice_id, amount_cents, method, status, stripe_payment_intent_id) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-00000000e001', 100, 'card', 'succeeded', 'pi_fake')$$);
call sqltest.expect_rows('member records an e-Transfer (recordPayment)',
  $$insert into public.invoice_payments (organization_id, company_id, invoice_id, amount_cents, method, status, reference, received_at, recorded_by) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-00000000e001', 20000, 'etransfer', 'succeeded', 'ref1', now(), '00000000-0000-0000-0000-0000000000a3')$$, 1);
call sqltest.expect_rows('member refreshes the balance (refresh_invoice_balance)',
  $$select * from public.refresh_invoice_balance('00000000-0000-0000-0000-00000000e001')$$, 1);
do $$
declare r public.invoices%rowtype;
begin
  select * into r from public.invoices where id = '00000000-0000-0000-0000-00000000e001';
  if r.amount_paid_cents <> 20000 or r.balance_due_cents <> 30000 or r.status <> 'partially_paid' then
    raise exception 'FAIL refresh_invoice_balance produced paid=% balance=% status=%', r.amount_paid_cents, r.balance_due_cents, r.status;
  end if;
  raise notice 'ok   refresh_invoice_balance derived paid=20000 balance=30000 partially_paid';
end $$;
call sqltest.expect_denied('member edits the lines of a part-paid invoice',
  $$update public.invoices set total_cents = 1 where id = '00000000-0000-0000-0000-00000000e001'$$);
call sqltest.expect_denied('member voids a part-paid invoice',
  $$update public.invoices set status = 'void', voided_at = now() where id = '00000000-0000-0000-0000-00000000e001'$$);
call sqltest.expect_denied('member bumps a recorded payment''s amount',
  $$update public.invoice_payments set amount_cents = 50000 where reference = 'ref1'$$);
call sqltest.expect_rows('member removes a mistaken payment (removePayment)',
  $$update public.invoice_payments set status = 'failed', failure_reason = 'Removed — recorded by mistake' where reference = 'ref1'$$, 1);
call sqltest.expect_denied('member refreshes ANOTHER org''s invoice',
  $$select * from public.refresh_invoice_balance('00000000-0000-0000-0000-00000000e0b1')$$);

-- Bookings: the online-booking deposit state is server-only.
call sqltest.expect_denied('member marks a booking deposit paid',
  $$update public.bookings set deposit_paid_at = now() where id = '00000000-0000-0000-0000-00000000b001'$$);
call sqltest.expect_denied('member changes a booking''s deposit amount',
  $$update public.bookings set deposit_cents = 0 where id = '00000000-0000-0000-0000-00000000b001'$$);
call sqltest.expect_rows('member reschedules + completes a booking',
  $$update public.bookings set scheduled_for = now() + interval '4 days', status = 'completed', completed_at = now(), completed_by = '00000000-0000-0000-0000-0000000000a3', location = 'Dock 4' where id = '00000000-0000-0000-0000-00000000b001'$$, 1);
call sqltest.expect_rows('member creates a booking',
  $$insert into public.bookings (organization_id, company_id, contact_id, title, scheduled_for, duration_minutes, created_by) values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000c7a01', 'Wash', now() + interval '5 days', 60, '00000000-0000-0000-0000-0000000000a3')$$, 1);

-- ═════════════════════════════════════════════════════════════════════════════
-- OWNER of Org A — may grant ownership; the last owner can't leave
-- ═════════════════════════════════════════════════════════════════════════════
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

call sqltest.expect_denied('owner sets organizations.plan too',
  $$update public.organizations set plan = 'internal' where id = '00000000-0000-0000-0000-00000000aaaa'$$);
call sqltest.expect_denied('sole owner demotes themselves',
  $$update public.organization_memberships set role = 'admin' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a1'$$);
call sqltest.expect_rows('owner makes the admin an owner (ownership transfer)',
  $$update public.organization_memberships set role = 'owner' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a2'$$, 1);
call sqltest.expect_rows('owner steps down to admin once another owner exists',
  $$update public.organization_memberships set role = 'admin' where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a1'$$, 1);

-- Cross-tenant: still nothing outside your own org (RLS), now with columns locked too.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
call sqltest.expect_rows('org B owner cannot see/touch org A (0 rows)',
  $$update public.organizations set name = 'pwned' where id = '00000000-0000-0000-0000-00000000aaaa'$$, 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- anon (publishable key, no JWT)
-- ═════════════════════════════════════════════════════════════════════════════
reset role;
set role anon;
reset request.jwt.claim.sub;
call sqltest.expect_denied('anon calls record_billing_event',
  $$select public.record_billing_event('evt_anon', 'invoice.paid', '{}'::jsonb, null)$$);
call sqltest.expect_denied('anon updates organizations.plan',
  $$update public.organizations set plan = 'internal'$$);

-- ═════════════════════════════════════════════════════════════════════════════
-- service_role keeps full write access (webhooks, workers, provisioning)
-- ═════════════════════════════════════════════════════════════════════════════
reset role;
set role service_role;
set request.jwt.claim.role = 'service_role';
call sqltest.expect_rows('service role sets plan/subscription_status',
  $$update public.organizations set plan = 'operate', subscription_status = 'active', crankleads_tier = 'close' where id = '00000000-0000-0000-0000-00000000aaaa'$$, 1);
call sqltest.expect_rows('service role approves a quote (public approve page)',
  $$update public.quotes set status = 'approved', approved_at = now(), approved_total_cents = total_cents where id = '00000000-0000-0000-0000-00000000f001'$$, 1);
call sqltest.expect_rows('service role mirrors Stripe Connect state',
  $$update public.companies set stripe_charges_enabled = true where id = '00000000-0000-0000-0000-0000000c0a01'$$, 1);
call sqltest.expect_rows('service role inserts a membership (invite acceptance)',
  $$insert into public.organization_memberships (organization_id, profile_id, role) values ('00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-0000000000a3', 'member')$$, 1);
call sqltest.expect_rows('service role records a billing event',
  $$select public.record_billing_event('evt_real', 'invoice.paid', '{}'::jsonb, null)$$, 1);

-- Put the fixtures back to their starting roles/billing state so postgrest-smoke.mjs
-- (run next, against this same database) starts from a known place.
reset role;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;
update public.organization_memberships set role = 'owner'
 where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a1';
update public.organization_memberships set role = 'admin'
 where organization_id = '00000000-0000-0000-0000-00000000aaaa' and profile_id = '00000000-0000-0000-0000-0000000000a2';
update public.organizations set plan = 'launch', subscription_status = 'active', crankleads_tier = null
 where id = '00000000-0000-0000-0000-00000000aaaa';
update public.quotes set status = 'sent', approved_at = null, approved_total_cents = null
 where id = '00000000-0000-0000-0000-00000000f001';

\echo 'lock_privileged_columns: ALL ASSERTIONS PASSED'
