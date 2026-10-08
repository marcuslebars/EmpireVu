-- Done-for-you: automatic switch-on (docs/done-for-you.md → "Automatic switch-on").
--
-- One row per CrankLeads company: what the orchestrator (services/dfy/orchestrator.ts) has
-- already done for the buyer, so every sweep is idempotent — the number purchase (with
-- bounded retries), the one-time switch-on (automations, booking hours, AI receptionist),
-- the one-tap forwarding link + text, the automatic forwarding test after the owner taps,
-- and the 24-hour operator escalation.
--
-- Additive only. Written by the server (service role) only; org members may READ their own
-- row (the "We're setting you up" view). Nothing here is client-writable
-- (20261006170000_lock_privileged_columns).
-- Rollback: supabase/rollback/20261008120000_dfy_autolive.down.sql

create table if not exists public.dfy_progress (
  company_id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Number purchase (catcher for Catch/Close, AI receptionist for Front Desk)
  number_attempts integer not null default 0,
  number_last_attempt_at timestamptz,
  number_last_error text,
  number_ready_at timestamptz,
  number_flagged_at timestamptz,
  -- One-time switch-on once the intake is enriched (or 2h passed without it)
  switched_on_at timestamptz,
  switch_on_detail jsonb not null default '{}'::jsonb,
  -- One-tap forwarding (/forward/:token)
  forward_token text unique,
  forward_text_sent_at timestamptz,
  forward_opened_at timestamptz,
  forward_tapped_at timestamptz,
  forward_help_requested_at timestamptz,
  forward_tests_started integer not null default 0,
  forward_last_test_at timestamptz,
  -- Operator escalation (not live 24h after purchase)
  escalated_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, organization_id) references public.companies (id, organization_id) on delete cascade
);

create index if not exists dfy_progress_org_idx on public.dfy_progress (organization_id);

drop trigger if exists dfy_progress_set_updated_at on public.dfy_progress;
create trigger dfy_progress_set_updated_at
before update on public.dfy_progress
for each row execute procedure public.touch_updated_at();

alter table public.dfy_progress enable row level security;
drop policy if exists "dfy_progress_select" on public.dfy_progress;
create policy "dfy_progress_select" on public.dfy_progress
  for select using (public.is_organization_member(organization_id));
revoke insert, update, delete on public.dfy_progress from anon, authenticated;

comment on table public.dfy_progress is
  'Done-for-you switch-on progress per CrankLeads company (services/dfy/orchestrator.ts). Service role writes only.';
comment on column public.dfy_progress.forward_token is
  'Unguessable token for the no-login one-tap forwarding page /forward/:token.';
