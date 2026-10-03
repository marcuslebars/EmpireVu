-- Rollback for 20261004130000_setup_followups.sql
-- Drops the follow-up send log and the live / opt-out columns. Purchases and orgs are untouched.
-- Does NOT touch voice_numbers.forwarding_verified_at (owned by 20261004120000).

drop policy if exists "crankleads_setup_followups_members_select" on public.crankleads_setup_followups;
drop trigger if exists crankleads_setup_followups_set_updated_at on public.crankleads_setup_followups;
drop index if exists public.crankleads_setup_followups_org_company_idx;
drop index if exists public.crankleads_setup_followups_one_reminder_per_day;
drop table if exists public.crankleads_setup_followups;

drop index if exists public.crankleads_purchases_not_live_idx;
drop index if exists public.crankleads_purchases_stop_token_idx;
alter table public.crankleads_purchases
  drop column if exists setup_followups_exempt_at,
  drop column if exists setup_reminders_stop_token,
  drop column if exists setup_reminders_stopped_at,
  drop column if exists live_at;
