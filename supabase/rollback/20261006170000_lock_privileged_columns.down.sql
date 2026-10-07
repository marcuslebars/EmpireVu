-- Rollback for 20261006170000_lock_privileged_columns.sql.
--
-- WARNING: this re-opens the hole the migration closed (any org admin can set their own
-- plan / subscription status from the browser). Roll back only to unblock an outage, and
-- re-apply the migration as soon as the cause is fixed.
--
-- Restores Supabase's default table-level grants, the original policies and function
-- privileges, and drops the guard triggers and helpers. The server changes that shipped
-- with the migration (org creation and invoice "paid" effects via the service role, the
-- owner rules in organization-users.ts) keep working on the rolled-back schema.
-- Pending invitations revoked by the migration (role = owner) stay revoked.

-- ── table privileges ─────────────────────────────────────────────────────────
grant insert, update on
  public.organizations,
  public.organization_memberships,
  public.organization_invitations,
  public.profiles,
  public.companies,
  public.bookings,
  public.quotes,
  public.invoices,
  public.invoice_payments
to anon, authenticated;

grant insert, update, delete on
  public.subscriptions,
  public.billing_events,
  public.billing_event_jobs,
  public.feature_flags,
  public.usage_events,
  public.company_stripe_customers,
  public.invoice_number_counters,
  public.quote_number_counters
to anon, authenticated;
-- crankleads_purchases: its own migration (20261003120000) revoked all from clients;
-- leave it that way.

-- ── triggers + guard functions ───────────────────────────────────────────────
drop trigger if exists organization_memberships_guard on public.organization_memberships;
drop trigger if exists quotes_guard_client_write on public.quotes;
drop trigger if exists invoices_guard_client_write on public.invoices;
drop trigger if exists invoice_payments_guard_client_write on public.invoice_payments;
drop function if exists public.guard_organization_membership_change();
drop function if exists public.guard_quote_client_write();
drop function if exists public.guard_invoice_client_write();
drop function if exists public.guard_invoice_payment_client_write();
drop function if exists public.membership_role_rank(public.membership_role);
drop function if exists public.is_organization_owner(uuid);
drop function if exists public.is_client_role();

-- ── organization_invitations policies ────────────────────────────────────────
drop policy if exists "organization_invitations_admins_insert" on public.organization_invitations;
drop policy if exists "organization_invitations_admins_revoke" on public.organization_invitations;
drop policy if exists "organization_invitations_org_members_insert" on public.organization_invitations;
drop policy if exists "organization_invitations_org_members_update" on public.organization_invitations;
create policy "organization_invitations_org_members_insert"
on public.organization_invitations
for insert
with check (public.is_organization_member(organization_id));
create policy "organization_invitations_org_members_update"
on public.organization_invitations
for update
using (public.is_organization_member(organization_id))
with check (public.is_organization_member(organization_id));

-- ── refresh_invoice_balance back to SECURITY INVOKER ─────────────────────────
create or replace function public.refresh_invoice_balance(p_invoice_id uuid)
returns setof public.invoices
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_paid integer;
  v_pending integer;
begin
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
grant execute on function public.refresh_invoice_balance(uuid) to public, anon, authenticated, service_role;

-- ── next_quote_number without the membership check ──────────────────────────
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
  insert into public.quote_number_counters (organization_id, year, last_number)
  values (p_organization_id, v_year, 1)
  on conflict (organization_id, year)
    do update set last_number = public.quote_number_counters.last_number + 1
  returning last_number into v_next;

  return 'Q-' || v_year::text || '-' || lpad(v_next::text, 4, '0');
end;
$$;
grant execute on function public.next_quote_number(uuid) to anon, authenticated, service_role;

-- ── worker-only functions: restore the default EXECUTE grants ────────────────
grant execute on function public.record_billing_event(text, text, jsonb, uuid) to public, anon, authenticated;
grant execute on function public.claim_billing_event_jobs(text, integer, integer) to public, anon, authenticated;
grant execute on function public.claim_workflow_event_jobs(text, integer, integer) to public, anon, authenticated;
grant execute on function public.claim_jobber_sync_jobs(text, integer, integer) to public, anon, authenticated;
grant execute on function public.claim_inbound_webhook_jobs(integer, text, integer) to public, anon, authenticated;
grant execute on function public.claim_waiting_workflow_runs(integer, integer) to public, anon, authenticated;
grant execute on function public.claim_workflow_schedule_ticks(integer, text, integer) to public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to public, anon, authenticated;
grant execute on function public.record_review_click(text) to anon, authenticated;
