-- Expenses & receipts.
--   * expenses — money the business spent: on a job or general overhead, with an optional
--     receipt (photo or PDF), a category, the tax paid, who paid (business or out of pocket,
--     with reimbursement tracking) and whether it is billed on to the customer.
--   * expense-receipts — a private storage bucket. No storage policies on purpose: the
--     server mints signed upload / read URLs, so a crew member can never list or open
--     someone else's receipts directly.
--   * billable_expenses_for_booking / mark_expenses_billed — invoicing a job adds its
--     billable expenses as lines. Security definer because the person invoicing (possibly
--     a crew member finishing the job) can't see other people's expenses under RLS.
-- Rollback: supabase/rollback/20261005180000_expenses.down.sql

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  booking_id uuid references public.bookings (id) on delete set null,
  spent_on date not null,
  vendor text check (vendor is null or char_length(vendor) <= 200),
  description text check (description is null or char_length(description) <= 1000),
  category text not null default 'other' check (category in (
    'materials', 'fuel', 'equipment', 'tools', 'subcontractor', 'vehicle', 'insurance',
    'office', 'marketing', 'meals', 'travel', 'utilities', 'fees', 'other'
  )),
  -- What was paid, tax included; tax_cents is the sales tax inside it (for tax credits).
  amount_cents integer not null check (amount_cents between 1 and 100000000),
  tax_cents integer not null default 0 check (tax_cents >= 0 and tax_cents <= amount_cents),
  paid_with text not null default 'business' check (paid_with in ('business', 'personal')),
  reimbursed_at timestamptz,
  reimbursed_by uuid references public.profiles (id) on delete set null,
  billable boolean not null default false,
  billed_invoice_id uuid references public.invoices (id) on delete set null,
  receipt_path text unique check (receipt_path is null or char_length(receipt_path) <= 512),
  receipt_type text check (receipt_type is null or receipt_type in ('image/jpeg', 'application/pdf')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (reimbursed_at is null or paid_with = 'personal'),
  check ((receipt_path is null) = (receipt_type is null))
);

create index if not exists expenses_org_spent_idx on public.expenses (organization_id, spent_on desc);
create index if not exists expenses_booking_idx on public.expenses (booking_id) where booking_id is not null;
create index if not exists expenses_owed_idx on public.expenses (organization_id)
  where paid_with = 'personal' and reimbursed_at is null;

drop trigger if exists expenses_set_updated_at on public.expenses;
create trigger expenses_set_updated_at
before update on public.expenses
for each row execute procedure public.touch_updated_at();

alter table public.expenses enable row level security;

drop policy if exists "expenses_select" on public.expenses;
drop policy if exists "expenses_insert" on public.expenses;
drop policy if exists "expenses_update" on public.expenses;
drop policy if exists "expenses_delete" on public.expenses;

-- Your own expenses; owners/admins see everyone's.
create policy "expenses_select"
  on public.expenses for select
  using (
    public.is_organization_member(organization_id)
    and (created_by = auth.uid() or public.is_organization_admin(organization_id))
  );

-- Logged by yourself, not yet reimbursed or billed, and pointing only inside your org.
create policy "expenses_insert"
  on public.expenses for insert
  with check (
    public.is_organization_member(organization_id)
    and created_by = auth.uid()
    and reimbursed_at is null
    and billed_invoice_id is null
    and (booking_id is null or exists (select 1 from public.bookings b where b.id = booking_id and b.organization_id = expenses.organization_id))
    and (company_id is null or exists (select 1 from public.companies c where c.id = company_id and c.organization_id = expenses.organization_id))
  );

-- Owners/admins edit anything; crew edit their own until it's reimbursed or billed.
create policy "expenses_update"
  on public.expenses for update
  using (
    public.is_organization_member(organization_id)
    and (
      public.is_organization_admin(organization_id)
      or (created_by = auth.uid() and reimbursed_at is null and billed_invoice_id is null)
    )
  )
  with check (
    public.is_organization_member(organization_id)
    and (
      public.is_organization_admin(organization_id)
      or (created_by = auth.uid() and reimbursed_at is null and billed_invoice_id is null)
    )
    and (booking_id is null or exists (select 1 from public.bookings b where b.id = booking_id and b.organization_id = expenses.organization_id))
    and (company_id is null or exists (select 1 from public.companies c where c.id = company_id and c.organization_id = expenses.organization_id))
    and (billed_invoice_id is null or exists (select 1 from public.invoices i where i.id = billed_invoice_id and i.organization_id = expenses.organization_id))
  );

create policy "expenses_delete"
  on public.expenses for delete
  using (
    public.is_organization_member(organization_id)
    and (
      public.is_organization_admin(organization_id)
      or (created_by = auth.uid() and reimbursed_at is null and billed_invoice_id is null)
    )
  );

grant select, insert, update, delete on public.expenses to authenticated, service_role;

-- ── Receipts bucket (private; server-signed URLs only) ────────────────────────
-- Path: {organization_id}/{uuid}.jpg|pdf
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('expense-receipts', 'expense-receipts', false, 10485760, array['image/jpeg', 'application/pdf'])
on conflict (id) do nothing;

-- ── Billable expenses → the job's invoice ─────────────────────────────────────
-- An expense counts as unbilled when it was never billed, or its invoice was voided.
create or replace function public.billable_expenses_for_booking(p_booking_id uuid)
returns table (id uuid, vendor text, description text, category text, amount_cents integer, tax_cents integer, spent_on date)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select b.organization_id into v_org from public.bookings b where b.id = p_booking_id;
  if v_org is null or not public.is_organization_member(v_org) then
    return;
  end if;
  return query
    select e.id, e.vendor, e.description, e.category, e.amount_cents, e.tax_cents, e.spent_on
      from public.expenses e
      left join public.invoices i on i.id = e.billed_invoice_id
     where e.organization_id = v_org
       and e.booking_id = p_booking_id
       and e.billable
       and (e.billed_invoice_id is null or i.status = 'void')
     order by e.spent_on, e.created_at;
end;
$$;

create or replace function public.mark_expenses_billed(p_invoice_id uuid, p_expense_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_booking uuid;
  v_count integer;
begin
  select i.organization_id, i.booking_id into v_org, v_booking from public.invoices i where i.id = p_invoice_id and i.status <> 'void';
  if v_org is null or v_booking is null or not public.is_organization_member(v_org) then
    return 0;
  end if;
  update public.expenses e
     set billed_invoice_id = p_invoice_id
   where e.id = any (p_expense_ids)
     and e.organization_id = v_org
     and e.booking_id = v_booking
     and e.billable
     and (
       e.billed_invoice_id is null
       or exists (select 1 from public.invoices old where old.id = e.billed_invoice_id and old.status = 'void')
     );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.billable_expenses_for_booking(uuid) from public;
revoke all on function public.mark_expenses_billed(uuid, uuid[]) from public;
grant execute on function public.billable_expenses_for_booking(uuid) to authenticated, service_role;
grant execute on function public.mark_expenses_billed(uuid, uuid[]) to authenticated, service_role;
