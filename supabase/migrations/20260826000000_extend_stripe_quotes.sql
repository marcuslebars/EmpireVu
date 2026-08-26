-- Stripe-native quotes — Phase 2 remediation: the columns the hosted quote page
-- (Phase 3) and the balance/job flow (Phase 4) need, plus per-org quote numbers.
--
-- Additive throughout: new nullable columns, new defaults, one widened check
-- constraint, one new counter table. Nothing existing is dropped or retyped, so
-- the rows written by 20260812000000 stay valid.
--
-- Why each piece exists:
--   • title / intro_message  — the customer-facing heading and the personal note
--     at the top of /q/{public_token}. Seeded from an org default template.
--   • viewed / completed     — the lifecycle spec is draft|sent|viewed|approved|
--     deposit_paid|completed|expired|cancelled. The original check omitted
--     'viewed' (set on first open in Phase 3) and 'completed' (set when the
--     balance invoice is paid in Phase 4), so neither phase could persist its
--     terminal state. Widened here.
--   • approval snapshot      — who approved, when, from where, and the EXACT
--     line-item selection at approval. Optional line items are customer
--     toggleable, so the cart at approval is what we charge and what we owe
--     work against; it must be frozen separately from the (mutable) quote.
--   • valid_until            — spec default is sent + 30 days. Kept alongside
--     the original expires_at rather than renaming it: expires_at stays the
--     column the Phase 3 expiry cron reads, valid_until is the customer-facing
--     date shown on the page. They are set together on send.
--   • auto_generated         — Phase 5 self-serve quotes must be reviewable and
--     must never be issued twice for one lead (unique partial index below).

-- ─────────────────────────────────────────────────────────────────────────────
-- Customer-facing content
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.quotes add column if not exists title text;
alter table public.quotes add column if not exists intro_message text;

-- ─────────────────────────────────────────────────────────────────────────────
-- Lifecycle: widen the status check to the full spec set.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.quotes drop constraint if exists quotes_status_check;
alter table public.quotes add constraint quotes_status_check
  check (status in (
    'draft', 'sent', 'viewed', 'approved',
    'deposit_paid', 'completed', 'expired', 'cancelled'
  ));

alter table public.quotes add column if not exists sent_at timestamptz;
alter table public.quotes add column if not exists first_viewed_at timestamptz;
alter table public.quotes add column if not exists completed_at timestamptz;

-- Customer-facing validity date (spec: sent + 30 days). expires_at remains the
-- machine-read column for the expiry cron.
alter table public.quotes add column if not exists valid_until timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- Approval snapshot (Phase 3). approved_line_items is the frozen selection —
-- including which optional lines the customer ticked — that the deposit and the
-- balance are both computed from.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.quotes add column if not exists approved_at timestamptz;
alter table public.quotes add column if not exists approved_by_name text;
alter table public.quotes add column if not exists approved_ip inet;
alter table public.quotes add column if not exists approved_user_agent text;
alter table public.quotes add column if not exists approved_line_items jsonb;
alter table public.quotes add column if not exists approved_subtotal_cents integer;
alter table public.quotes add column if not exists approved_tax_cents integer;
alter table public.quotes add column if not exists approved_total_cents integer;
alter table public.quotes add column if not exists approved_deposit_cents integer;
alter table public.quotes add column if not exists terms_accepted boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 4 (balance invoice) + Phase 5 (self-serve) columns, nullable now.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.quotes add column if not exists stripe_customer_id text;
alter table public.quotes add column if not exists stripe_invoice_id text;
alter table public.quotes add column if not exists stripe_payment_method_id text;
alter table public.quotes add column if not exists balance_paid_at timestamptz;

alter table public.quotes add column if not exists auto_generated boolean not null default false;
alter table public.quotes add column if not exists source_lead_id uuid;

-- One auto-quote per lead, ever. Partial so manually-created quotes are exempt
-- and so historical rows (source_lead_id null) don't collide.
create unique index if not exists quotes_auto_generated_lead_uniq
  on public.quotes (organization_id, source_lead_id)
  where auto_generated and source_lead_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-org human-readable quote numbers: Q-2026-0001, restarting each year per
-- organization. Allocated by an atomic upsert so two concurrent creates cannot
-- collide; the unique index is the backstop.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.quote_number_counters (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  year integer not null,
  last_number integer not null default 0,
  primary key (organization_id, year)
);

alter table public.quote_number_counters enable row level security;

create policy "quote_number_counters_org_members_select" on public.quote_number_counters
  for select using (public.is_organization_member(organization_id));

create unique index if not exists quotes_org_quote_number_uniq
  on public.quotes (organization_id, quote_number)
  where quote_number is not null;

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

revoke all on function public.next_quote_number(uuid) from public;
grant execute on function public.next_quote_number(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes for the Phase 3 hosted page and the expiry cron.
-- ─────────────────────────────────────────────────────────────────────────────
create index if not exists quotes_expiry_sweep_idx
  on public.quotes (expires_at)
  where status in ('sent', 'viewed');

create index if not exists quotes_auto_review_idx
  on public.quotes (organization_id, created_at desc)
  where auto_generated;
