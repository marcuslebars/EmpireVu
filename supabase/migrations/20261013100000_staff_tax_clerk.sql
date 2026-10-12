-- Phase 4 AI staff: the TAX CLERK, receipts by text and the HST worksheet
-- (docs/ai-staff.md → "Receipts & HST").
--
--   1. receipt_texts: one row per receipt picture the OWNER texted to the platform number
--      (unique per owner_command_log id + media index, so a Twilio redelivery files nothing
--      twice). It points at the `expenses` row it created (expenses stay the record — they sync
--      to QuickBooks/Xero as before), keeps the owner's words, the PO reference ("PO-12", which
--      the Purchasing role matches on) and, for a receipt the reader couldn't finish (no total),
--      the picture and what was read until the owner fills in the rest. No expense is created
--      for those: expenses.amount_cents must be > 0 and a placeholder would sync to the books.
--   2. hst_periods: one row per company per HST reporting period, created when the owner is
--      reminded (10 days before the due date) or asks for the packet. It is the claim for the
--      reminder and for the accountant packet email, and keeps the figures that were texted.
--   3. tax_clerk_notices: once-only claims for the Monday receipt nudge and the first-week tip.
--
-- Nothing changes on expenses, invoices or the expense-receipts bucket: PNG pictures are
-- wrapped in a PDF before upload, so the bucket's jpeg/pdf rule and expenses.receipt_type stay.
-- Settings live in companies.ai_settings.tax_clerk (read in code, defaults there).
-- Additive and re-runnable. Nothing here is client-writable (see 20261006170000); owners/admins
-- read receipt_texts and hst_periods (money), nobody but the service role touches the notices.
-- Rollback: supabase/rollback/20261013100000_staff_tax_clerk.down.sql

-- ── 1. Receipts texted in ──────────────────────────────────────────────────────────
create table if not exists public.receipt_texts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  -- owner_command_log.id of the text that carried the picture (the idempotency key).
  log_id uuid not null,
  media_index smallint not null default 0 check (media_index between 0 and 9),
  status text not null default 'reading'
    check (status in ('reading', 'filed', 'duplicate', 'needs_review', 'not_receipt', 'failed', 'deleted', 'discarded')),
  expense_id uuid references public.expenses(id) on delete set null,
  duplicate_of uuid references public.expenses(id) on delete set null,
  -- The picture in the expense-receipts bucket ({organization_id}/{uuid}.jpg|pdf).
  file_path text check (file_path is null or char_length(file_path) <= 512),
  file_type text check (file_type is null or file_type in ('image/jpeg', 'application/pdf')),
  -- What was read / decided (the expense row is the record once filed).
  vendor text check (vendor is null or char_length(vendor) <= 200),
  spent_on date,
  amount_cents integer check (amount_cents is null or amount_cents between 0 and 100000000),
  tax_cents integer check (tax_cents is null or tax_cents between 0 and 100000000),
  category text check (category is null or char_length(category) <= 40),
  description text check (description is null or char_length(description) <= 1000),
  booking_id uuid references public.bookings(id) on delete set null,
  paid_with text check (paid_with is null or paid_with in ('business', 'personal')),
  po_reference text check (po_reference is null or po_reference ~ '^PO-[0-9]{1,9}$'),
  owner_words text check (owner_words is null or char_length(owner_words) <= 500),
  missing text[] not null default '{}',
  reply text check (reply is null or char_length(reply) <= 700),
  filed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (log_id, media_index),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists receipt_texts_company_idx on public.receipt_texts (company_id, created_at desc);
create index if not exists receipt_texts_po_idx on public.receipt_texts (company_id, po_reference) where po_reference is not null;
create index if not exists receipt_texts_expense_idx on public.receipt_texts (expense_id) where expense_id is not null;
create index if not exists receipt_texts_review_idx on public.receipt_texts (company_id) where status = 'needs_review';

-- ── 2. HST periods ─────────────────────────────────────────────────────────────────
create table if not exists public.hst_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  frequency text not null check (frequency in ('monthly', 'quarterly', 'annual')),
  period_start date not null,
  period_end date not null,
  -- The return's due date, and when the payment is due (earlier for annual individual filers).
  due_date date not null,
  payment_due_date date not null,
  label text not null check (char_length(label) <= 40),
  -- pending: made for a packet the owner asked for before any reminder (the reminder still runs);
  -- reminding: claimed by a reminder pass; reminded / failed / skipped: its outcome.
  status text not null default 'pending'
    check (status in ('pending', 'reminding', 'reminded', 'failed', 'skipped')),
  reminded_at timestamptz,
  reminder_body text check (reminder_body is null or char_length(reminder_body) <= 700),
  -- { salesCents, collectedCents, itcCents, netCents, … } as texted.
  figures jsonb not null default '{}'::jsonb,
  approval_id uuid references public.owner_approvals(id) on delete set null,
  packet_claimed_at timestamptz,
  packet_emailed_at timestamptz,
  packet_emailed_to text check (packet_emailed_to is null or char_length(packet_emailed_to) <= 254),
  packet_error text check (packet_error is null or char_length(packet_error) <= 500),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (company_id, period_start, period_end),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);
create index if not exists hst_periods_company_idx on public.hst_periods (company_id, period_end desc);

-- ── 3. Once-only notices ──────────────────────────────────────────────────────────
create table if not exists public.tax_clerk_notices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null,
  kind text not null check (kind in ('first_seen', 'receipt_tip', 'weekly_nudge')),
  -- 'once' for the tip / first sighting, the local Monday (YYYY-MM-DD) for the nudge.
  key text not null check (char_length(key) <= 40),
  status text not null default 'claimed' check (status in ('claimed', 'sent', 'skipped', 'failed')),
  body text check (body is null or char_length(body) <= 700),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, kind, key),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

-- ── RLS + grants ───────────────────────────────────────────────────────────────────
alter table public.receipt_texts enable row level security;
alter table public.hst_periods enable row level security;
alter table public.tax_clerk_notices enable row level security;

-- Money: owners/admins only (expenses themselves keep their own policies).
drop policy if exists "receipt_texts_select" on public.receipt_texts;
create policy "receipt_texts_select" on public.receipt_texts
  for select using (public.is_organization_admin(organization_id));
drop policy if exists "hst_periods_select" on public.hst_periods;
create policy "hst_periods_select" on public.hst_periods
  for select using (public.is_organization_admin(organization_id));

revoke insert, update, delete on public.receipt_texts, public.hst_periods from anon, authenticated;
revoke select on public.receipt_texts, public.hst_periods from anon;
revoke all on public.tax_clerk_notices from anon, authenticated;
grant select on public.receipt_texts, public.hst_periods to authenticated;
grant all on public.receipt_texts, public.hst_periods, public.tax_clerk_notices to service_role;

drop trigger if exists receipt_texts_set_updated_at on public.receipt_texts;
create trigger receipt_texts_set_updated_at before update on public.receipt_texts
  for each row execute procedure public.touch_updated_at();
drop trigger if exists hst_periods_set_updated_at on public.hst_periods;
create trigger hst_periods_set_updated_at before update on public.hst_periods
  for each row execute procedure public.touch_updated_at();
