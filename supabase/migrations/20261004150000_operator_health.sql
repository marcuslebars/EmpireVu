-- Daily operator health email (docs/operator-health.md).
--
-- Once per day (~07:30 BUSINESS_TIMEZONE) the workflow-event worker's scheduler pass builds a
-- cross-tenant "what needs a human" report — stalled CrankLeads setups (5-business-day live
-- guarantee), broken call forwarding, past-due payments, failed/stuck provisioning, silent live
-- accounts, open support requests older than 24h, queue health — and emails it to OWNER_EMAIL.
-- Nothing needs attention → nothing is sent (except an optional weekly "all clear").
--
-- operator_health_reports is the per-day idempotency guard + send log. The job INSERTS (claims)
-- the row for the operator-local calendar date BEFORE sending, so a restart, a second worker or
-- a re-run can never send the same day's report twice (unique report_date).
--
-- TENANCY EXCEPTION (convention #1): this is a PLATFORM-level, operator-only table — one row per
-- day across all tenants, never belonging to an organization — so it has no organization_id. It
-- stores counts and the subject line only (no tenant row content). Service-role only: RLS is
-- enabled with NO policies and anon/authenticated have no grants. Written by the worker's
-- scheduler pass (SANCTIONED EXCEPTION, listed in docs/EMPIREVU_RUNBOOK.md).
--
-- Additive only. Rollback: supabase/rollback/20261004150000_operator_health.down.sql.

create table if not exists public.operator_health_reports (
  id uuid primary key default gen_random_uuid(),
  -- Operator-local calendar date (YYYY-MM-DD in BUSINESS_TIMEZONE) the report covers.
  report_date date not null unique,
  -- 'sending' (claimed, email in flight) → 'sent' | 'failed'; 'quiet' = nothing needed a human
  -- and it was not an all-clear day, so no email went out.
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'failed', 'quiet')),
  item_count integer not null default 0 check (item_count >= 0),
  guarantee_at_risk integer not null default 0 check (guarantee_at_risk >= 0),
  all_clear boolean not null default false,
  subject text,
  -- { "<section key>": <item count>, ... } — counts only, never tenant row content.
  summary jsonb not null default '{}'::jsonb,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists operator_health_reports_set_updated_at on public.operator_health_reports;
create trigger operator_health_reports_set_updated_at
before update on public.operator_health_reports
for each row execute procedure public.touch_updated_at();

alter table public.operator_health_reports enable row level security;
-- No policies on purpose: service role only (it bypasses RLS).
revoke all on public.operator_health_reports from anon, authenticated;
