-- Lock billing, entitlement and money columns against direct client writes.
--
-- Why: the browser talks to PostgREST with the user's JWT (role `authenticated`), and
-- Supabase grants `authenticated` UPDATE/INSERT on EVERY column of every public table by
-- default. RLS decides WHICH ROWS a user may touch; it says nothing about WHICH COLUMNS.
-- So any org admin could, from the browser console, rewrite their own organizations row
-- (plan, subscription_status, trial_ends_at, crankleads_tier, stripe_customer_id…) and
-- gating would treat them as a fully-featured, billing-exempt house tenant.
--
-- The fix, per table: take away the blanket table-level privilege and grant back ONLY the
-- columns the app itself writes through the user's session (inventoried from src/server —
-- the web and mobile clients write no tables directly). Column grants are an allowlist, so
-- a column added later is locked until a migration grants it. Where a column must be
-- writable in some states but not others (status, role), a trigger enforces the same rule
-- the server routes already enforce. The service role (webhooks, workers, provisioning) is
-- unaffected: it keeps its grants and every trigger below lets it through.
--
-- Also closes, in the same class:
--   • SECURITY DEFINER RPCs that only the server's workers should call (record_billing_event,
--     the claim_* job queues, consume_rate_limit, record_review_click) were executable by
--     anon/authenticated. record_billing_event in particular let a user enqueue a forged
--     "Stripe" event that the billing worker would apply to their org.
--   • organization_invitations: any member could create an invitation, with any role
--     (including owner), or edit one.
--   • organization_memberships: no client may insert memberships (an org's creator could
--     re-add themselves as owner after being removed); only owners may grant or remove
--     ownership; nobody may raise their own role; the last owner can't be demoted/removed.
--   • profiles.email is the identity the platform matches on (CrankLeads provisioning,
--     owner notifications); it now only changes through Supabase Auth.
--   • quotes / invoices / invoice_payments: status, approval snapshot, paid amounts and
--     Stripe ids can no longer be written directly; the approve/pay paths stay server-only.
--   • refresh_invoice_balance becomes SECURITY DEFINER (with the same membership check as
--     next_invoice_number) so it can keep deriving the now-locked paid columns.
--   • next_quote_number checks membership (any user could advance any org's counter).
--
-- Idempotent: REVOKE/GRANT, CREATE OR REPLACE, DROP … IF EXISTS before every CREATE.
-- Rollback: supabase/rollback/20261006170000_lock_privileged_columns.down.sql
-- Verify:   scripts/sql-tests/run.sh (see scripts/sql-tests/README.md)

-- ═════════════════════════════════════════════════════════════════════════════
-- Helpers
-- ═════════════════════════════════════════════════════════════════════════════

-- True when the statement is running as a client of PostgREST (the publishable key with or
-- without a user JWT). The service role, the table owner (migrations, SQL editor) and
-- SECURITY DEFINER functions owned by postgres all run as other roles and are trusted.
create or replace function public.is_client_role()
returns boolean
language sql
stable
set search_path = public
as $$
  select current_user in ('authenticated', 'anon');
$$;

create or replace function public.is_organization_owner(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = target_organization_id
      and membership.profile_id = auth.uid()
      and membership.role = 'owner'
  );
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- organizations — clients may rename; everything billing is server-only
-- ═════════════════════════════════════════════════════════════════════════════
-- Writers through the user's session: PATCH /api/organizations/:id (name, slug).
-- Creation moved to the service role in POST /api/organizations, which stamps the trial
-- fields itself; clients can no longer INSERT an organizations row (or pick its plan).
revoke insert, update on public.organizations from anon, authenticated;
grant update (name, slug) on public.organizations to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- organization_memberships — role changes only, and only under the owner rules
-- ═════════════════════════════════════════════════════════════════════════════
-- Writers through the user's session: PATCH/DELETE /api/organizations/:id/members/:pid
-- (role; remove). Memberships are created only by the service role (org creation,
-- invitation acceptance, CrankLeads provisioning).
revoke insert, update on public.organization_memberships from anon, authenticated;
grant update (role) on public.organization_memberships to authenticated;

create or replace function public.membership_role_rank(r public.membership_role)
returns integer
language sql
immutable
as $$
  select case r when 'owner' then 3 when 'admin' then 2 else 1 end;
$$;

create or replace function public.guard_organization_membership_change()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_owners integer;
begin
  if not public.is_client_role() then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' then
    if new.role is not distinct from old.role then
      return new;
    end if;
    if (old.role = 'owner' or new.role = 'owner') and not public.is_organization_owner(old.organization_id) then
      raise exception 'Only an owner can grant or remove owner access.' using errcode = '42501';
    end if;
    if old.profile_id = auth.uid()
       and public.membership_role_rank(new.role) > public.membership_role_rank(old.role) then
      raise exception 'You cannot raise your own role.' using errcode = '42501';
    end if;
    if old.role = 'owner' and new.role <> 'owner' then
      select count(*) into v_owners
      from public.organization_memberships
      where organization_id = old.organization_id and role = 'owner';
      if v_owners <= 1 then
        raise exception 'An organization must have at least one owner.' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- DELETE
  if old.role = 'owner' then
    if not public.is_organization_owner(old.organization_id) then
      raise exception 'Only an owner can remove an owner.' using errcode = '42501';
    end if;
    select count(*) into v_owners
    from public.organization_memberships
    where organization_id = old.organization_id and role = 'owner';
    if v_owners <= 1 then
      raise exception 'An organization must have at least one owner.' using errcode = '42501';
    end if;
  end if;
  return old;
end;
$$;

drop trigger if exists organization_memberships_guard on public.organization_memberships;
create trigger organization_memberships_guard
before update or delete on public.organization_memberships
for each row execute function public.guard_organization_membership_change();

-- ═════════════════════════════════════════════════════════════════════════════
-- organization_invitations — admins only, never an owner invite, revoke-only edits
-- ═════════════════════════════════════════════════════════════════════════════
-- Writers through the user's session: POST /members/invitations (insert) and
-- DELETE /members/invitations/:id (status → revoked). Acceptance is service role.
revoke insert, update on public.organization_invitations from anon, authenticated;
grant insert (organization_id, email, role, token, invited_by_profile_id)
  on public.organization_invitations to authenticated;
grant update (status) on public.organization_invitations to authenticated;

drop policy if exists "organization_invitations_org_members_insert" on public.organization_invitations;
drop policy if exists "organization_invitations_admins_insert" on public.organization_invitations;
create policy "organization_invitations_admins_insert"
on public.organization_invitations
for insert
with check (
  public.is_organization_admin(organization_id)
  and role <> 'owner'
  and status = 'pending'
  and invited_by_profile_id = auth.uid()
);

drop policy if exists "organization_invitations_org_members_update" on public.organization_invitations;
drop policy if exists "organization_invitations_admins_revoke" on public.organization_invitations;
create policy "organization_invitations_admins_revoke"
on public.organization_invitations
for update
using (public.is_organization_admin(organization_id))
with check (public.is_organization_admin(organization_id) and status = 'revoked');

-- Ownership is never handed out by invitation (createInvitationInputSchema allows only
-- admin/member). Any pending owner invite could only have come from a direct write.
update public.organization_invitations
   set status = 'revoked'
 where status = 'pending'
   and role = 'owner';

-- ═════════════════════════════════════════════════════════════════════════════
-- profiles — email mirrors Supabase Auth; only display fields are self-editable
-- ═════════════════════════════════════════════════════════════════════════════
-- Profiles are created by the on_auth_user_created trigger (and service-role upserts).
revoke insert, update on public.profiles from anon, authenticated;
grant update (full_name, avatar_url, default_organization_id) on public.profiles to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- companies — business profile and settings yes; Stripe Connect mirror no
-- ═════════════════════════════════════════════════════════════════════════════
-- Writers through the user's session: createCompany; updateCompany (onboarding/settings);
-- invoice, review, online-booking, visit, digest and scorecard settings; industry packs.
-- Locked (service role only): stripe_connected_account_id, stripe_charges_enabled,
-- stripe_payouts_enabled, stripe_details_submitted, stripe_requirements,
-- stripe_connect_updated_at, stripe_account_label, stripe_mode,
-- stripe_statement_descriptor_suffix, quote_public_base_url, and anything added later.
revoke insert, update on public.companies from anon, authenticated;
grant insert (organization_id, name, slug, website, notes, stage, created_by)
  on public.companies to authenticated;
grant update (
  name, website, timezone, hours, service_area, owner_email, owner_phone_e164,
  brand_logo_url, brand_website_url, brand_primary_color, brand_accent_color,
  brand_from_name, brand_reply_email, brand_reply_phone, brand_review_url,
  digest, monthly_scorecard, booking_policy, industry_pack,
  tax_registration_number, business_address,
  invoice_settings, review_settings, online_booking_settings, visit_settings,
  updated_at
) on public.companies to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- quotes — staff draft, price, send and void; the customer's approval and the
-- deposit are recorded only by the server (public approve page, Stripe webhook)
-- ═════════════════════════════════════════════════════════════════════════════
revoke insert, update on public.quotes from anon, authenticated;
grant insert (
  organization_id, company_id, contact_id, public_token, status, title, intro_message,
  currency, line_items, subtotal_cents, tax_cents, total_cents, deposit_cents,
  tax_rate_bps, deposit_rate_bps, deposit_flat_cents, bundle_id,
  input_snapshot, notes, source, expires_at, auto_generated, source_lead_id, created_by
) on public.quotes to authenticated;
grant update (
  company_id, contact_id, title, intro_message,
  currency, line_items, subtotal_cents, tax_cents, total_cents, deposit_cents,
  tax_rate_bps, deposit_rate_bps, deposit_flat_cents, bundle_id, input_snapshot, notes,
  status, quote_number, sent_at, valid_until, expires_at,
  supersedes, superseded_by, cancelled_at, cancel_reason
) on public.quotes to authenticated;

-- Mirrors quotes/lifecycle.ts for the edges staff may take (createQuote → draft,
-- sendQuote draft → sent, cancelQuote/reissueQuote → cancelled with no money taken).
-- viewed / approved / deposit_paid / completed / expired are server-only edges.
create or replace function public.guard_quote_client_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'New quotes start as drafts.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status = 'sent')
      or (new.status = 'cancelled'
          and old.status in ('draft', 'sent', 'viewed', 'approved', 'expired')
          and old.deposit_paid_at is null)
    ) then
      raise exception 'A quote cannot move from % to % here.', old.status, new.status using errcode = '42501';
    end if;
  end if;

  -- Once the customer has committed, the priced snapshot is what we owe work against.
  if old.status not in ('draft', 'sent', 'viewed')
     and (new.line_items, new.subtotal_cents, new.tax_cents, new.total_cents, new.deposit_cents,
          new.tax_rate_bps, new.deposit_rate_bps, new.deposit_flat_cents, new.currency, new.bundle_id)
         is distinct from
         (old.line_items, old.subtotal_cents, old.tax_cents, old.total_cents, old.deposit_cents,
          old.tax_rate_bps, old.deposit_rate_bps, old.deposit_flat_cents, old.currency, old.bundle_id) then
    raise exception 'This quote is % and its prices can no longer change.', old.status using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists quotes_guard_client_write on public.quotes;
create trigger quotes_guard_client_write
before insert or update on public.quotes
for each row execute function public.guard_quote_client_write();

-- ═════════════════════════════════════════════════════════════════════════════
-- invoices — staff draft, edit, send and void; what's been paid is derived from
-- the payments by refresh_invoice_balance, never written directly
-- ═════════════════════════════════════════════════════════════════════════════
revoke insert, update on public.invoices from anon, authenticated;
grant insert (
  organization_id, company_id, contact_id, customer_account_id, quote_id, booking_id,
  public_token, status, title, line_items, subtotal_cents, tax_rate_bps, tax_cents,
  total_cents, credit_cents, balance_due_cents, due_date, payment_terms_days, bill_to,
  notes, internal_notes, created_by
) on public.invoices to authenticated;
grant update (
  contact_id, customer_account_id, title, line_items, subtotal_cents, tax_rate_bps,
  tax_cents, total_cents, credit_cents, balance_due_cents, due_date, payment_terms_days,
  bill_to, notes, internal_notes,
  status, invoice_number, issue_date, sent_at, voided_at, void_reason
) on public.invoices to authenticated;

-- Mirrors invoices/service.ts: createInvoice → draft; sendInvoice draft → sent;
-- voidInvoice only with no money against it; edits only while unpaid and not void.
create or replace function public.guard_invoice_client_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'New invoices start as drafts.' using errcode = '42501';
    end if;
    -- quote_id's FK is not org-scoped; keep an invoice on its own org's quote.
    if new.quote_id is not null and not exists (
      select 1 from public.quotes q
      where q.id = new.quote_id and q.organization_id = new.organization_id
    ) then
      raise exception 'Quote not found.' using errcode = '42501';
    end if;
    new.balance_due_cents := new.total_cents - new.credit_cents;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status = 'sent')
      or (new.status = 'void' and old.amount_paid_cents = 0 and old.pending_payment_cents = 0)
    ) then
      raise exception 'An invoice cannot move from % to % here.', old.status, new.status using errcode = '42501';
    end if;
  end if;

  if (new.line_items, new.subtotal_cents, new.tax_rate_bps, new.tax_cents, new.total_cents,
      new.credit_cents, new.contact_id, new.customer_account_id)
     is distinct from
     (old.line_items, old.subtotal_cents, old.tax_rate_bps, old.tax_cents, old.total_cents,
      old.credit_cents, old.contact_id, old.customer_account_id) then
    if old.status not in ('draft', 'sent', 'viewed') or old.amount_paid_cents > 0 or old.pending_payment_cents > 0 then
      raise exception 'This invoice has payments against it (or is closed) and can''t be edited.' using errcode = '42501';
    end if;
  end if;

  -- The balance is derived, never typed in (same arithmetic as invoices/service.ts and
  -- refresh_invoice_balance).
  new.balance_due_cents := case
    when new.status = 'draft' then new.total_cents - new.credit_cents
    else greatest(new.total_cents - new.credit_cents - old.amount_paid_cents, 0)
  end;
  return new;
end;
$$;

drop trigger if exists invoices_guard_client_write on public.invoices;
create trigger invoices_guard_client_write
before insert or update on public.invoices
for each row execute function public.guard_invoice_client_write();

-- Was SECURITY INVOKER, which needed clients to hold UPDATE on the paid columns. Now it
-- runs as the owner and checks membership itself (same check as next_invoice_number).
create or replace function public.refresh_invoice_balance(p_invoice_id uuid)
returns setof public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_paid integer;
  v_pending integer;
begin
  select organization_id into v_org from public.invoices where id = p_invoice_id;
  if v_org is null then
    return;
  end if;
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_organization_member(v_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  select
    coalesce(sum(amount_cents) filter (where status = 'succeeded'), 0),
    coalesce(sum(amount_cents) filter (where status = 'pending'), 0)
  into v_paid, v_pending
  from public.invoice_payments
  where invoice_id = p_invoice_id;

  return query
  update public.invoices i
  set
    amount_paid_cents = v_paid,
    pending_payment_cents = v_pending,
    balance_due_cents = greatest(i.total_cents - i.credit_cents - v_paid, 0),
    status = case
      when i.status in ('draft', 'void') then i.status
      when i.total_cents - i.credit_cents - v_paid <= 0 then 'paid'
      when v_paid > 0 then 'partially_paid'
      when i.first_viewed_at is not null then 'viewed'
      else 'sent'
    end,
    paid_at = case
      when i.status not in ('draft', 'void') and i.total_cents - i.credit_cents - v_paid <= 0
        then coalesce(i.paid_at, timezone('utc', now()))
      else null
    end
  where i.id = p_invoice_id
  returning i.*;
end;
$$;

revoke all on function public.refresh_invoice_balance(uuid) from public, anon;
grant execute on function public.refresh_invoice_balance(uuid) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- invoice_payments — staff record offline money and remove their own mistakes;
-- online (Stripe) payments are written only by the webhook
-- ═════════════════════════════════════════════════════════════════════════════
revoke insert, update on public.invoice_payments from anon, authenticated;
grant insert (
  organization_id, company_id, invoice_id, amount_cents, method, status,
  reference, notes, received_at, recorded_by
) on public.invoice_payments to authenticated;
grant update (status, failure_reason) on public.invoice_payments to authenticated;

-- Mirrors recordPayment / removePayment in invoices/service.ts.
create or replace function public.guard_invoice_payment_client_write()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  if not public.is_client_role() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'succeeded' then
      raise exception 'Recorded payments are received payments.' using errcode = '42501';
    end if;
    select * into v_invoice from public.invoices
    where id = new.invoice_id and organization_id = new.organization_id;
    if not found or v_invoice.status in ('draft', 'void') then
      raise exception 'Payments can only be recorded against a sent invoice.' using errcode = '42501';
    end if;
    if new.company_id is distinct from v_invoice.company_id then
      raise exception 'Payment company does not match the invoice.' using errcode = '42501';
    end if;
    if new.amount_cents > v_invoice.balance_due_cents - v_invoice.pending_payment_cents then
      raise exception 'That is more than is owing on this invoice.' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.stripe_payment_intent_id is not null or old.stripe_checkout_session_id is not null then
    raise exception 'Online payments change only through Stripe.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (old.status = 'succeeded' and new.status = 'failed') then
    raise exception 'A recorded payment can only be removed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists invoice_payments_guard_client_write on public.invoice_payments;
create trigger invoice_payments_guard_client_write
before insert or update on public.invoice_payments
for each row execute function public.guard_invoice_payment_client_write();

-- ═════════════════════════════════════════════════════════════════════════════
-- bookings — scheduling and crew fields yes; online-booking deposit state no
-- ═════════════════════════════════════════════════════════════════════════════
-- Writers through the user's session: createBooking, updateBookingStatus,
-- rescheduleBooking, crew (location/description, en-route/start/complete), recurring
-- visit generation. Locked (service role only): price_cents, deposit_cents,
-- deposit_invoice_id, deposit_paid_at, hold_expires_at, customer_confirmed_at,
-- manage_token, quote_id, source_call_id, service_item_id — the online-booking deposit
-- and the customer's self-service link, which the booking invoice credits from.
revoke insert, update on public.bookings from anon, authenticated;
grant insert (
  organization_id, company_id, contact_id, title, description, location, scheduled_for,
  duration_minutes, status, window_key, source, created_by,
  recurring_job_id, occurrence_date, recurrence_exception
) on public.bookings to authenticated;
grant update (
  title, description, location, scheduled_for, duration_minutes, status, window_key,
  recurrence_exception, en_route_at, started_at, completed_at, completed_by
) on public.bookings to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Billing / entitlement / Stripe mirror tables — server-only writes
-- ═════════════════════════════════════════════════════════════════════════════
-- These already have RLS with no client write policy (so clients were refused anyway);
-- dropping the grants makes that hold even if a policy is ever added by mistake.
revoke insert, update, delete on
  public.subscriptions,
  public.billing_events,
  public.billing_event_jobs,
  public.feature_flags,
  public.usage_events,
  public.company_stripe_customers,
  public.crankleads_purchases,
  public.invoice_number_counters,
  public.quote_number_counters
from anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- Worker-only SECURITY DEFINER functions — service role only
-- ═════════════════════════════════════════════════════════════════════════════
-- All callers use the service-role client (webhooks, workers, rate limiter, /r/:token).
revoke all on function public.record_billing_event(text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.claim_billing_event_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_workflow_event_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_jobber_sync_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_inbound_webhook_jobs(integer, text, integer) from public, anon, authenticated;
revoke all on function public.claim_waiting_workflow_runs(integer, integer) from public, anon, authenticated;
revoke all on function public.claim_workflow_schedule_ticks(integer, text, integer) from public, anon, authenticated;
revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.record_review_click(text) from public, anon, authenticated;

grant execute on function public.record_billing_event(text, text, jsonb, uuid) to service_role;
grant execute on function public.claim_billing_event_jobs(text, integer, integer) to service_role;
grant execute on function public.claim_workflow_event_jobs(text, integer, integer) to service_role;
grant execute on function public.claim_jobber_sync_jobs(text, integer, integer) to service_role;
grant execute on function public.claim_inbound_webhook_jobs(integer, text, integer) to service_role;
grant execute on function public.claim_waiting_workflow_runs(integer, integer) to service_role;
grant execute on function public.claim_workflow_schedule_ticks(integer, text, integer) to service_role;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
grant execute on function public.record_review_click(text) to service_role;

-- next_quote_number: SECURITY DEFINER with no membership check, so any user could advance
-- any org's quote counter. Same check as next_invoice_number.
create or replace function public.next_quote_number(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from timezone('utc', now()))::integer;
  v_next integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_organization_member(p_organization_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  insert into public.quote_number_counters (organization_id, year, last_number)
  values (p_organization_id, v_year, 1)
  on conflict (organization_id, year)
    do update set last_number = public.quote_number_counters.last_number + 1
  returning last_number into v_next;

  return 'Q-' || v_year::text || '-' || lpad(v_next::text, 4, '0');
end;
$$;

revoke all on function public.next_quote_number(uuid) from public, anon;
grant execute on function public.next_quote_number(uuid) to authenticated, service_role;

-- Helpers: trigger-internal; not part of the API.
revoke all on function public.is_client_role() from public, anon;
grant execute on function public.is_client_role() to authenticated, service_role;
revoke all on function public.is_organization_owner(uuid) from public, anon;
grant execute on function public.is_organization_owner(uuid) to authenticated, service_role;
revoke all on function public.membership_role_rank(public.membership_role) from public, anon;
grant execute on function public.membership_role_rank(public.membership_role) to authenticated, service_role;
