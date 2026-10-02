-- Rollback for 20261002150000_monthly_scorecard.sql
drop policy if exists "monthly_scorecard_notes_admins_delete" on public.monthly_scorecard_notes;
drop policy if exists "monthly_scorecard_notes_admins_update" on public.monthly_scorecard_notes;
drop policy if exists "monthly_scorecard_notes_admins_insert" on public.monthly_scorecard_notes;
drop policy if exists "monthly_scorecard_notes_members_select" on public.monthly_scorecard_notes;
drop index if exists public.monthly_scorecard_notes_org_company_month_idx;
drop table if exists public.monthly_scorecard_notes;

drop policy if exists "monthly_scorecard_sends_members_select" on public.monthly_scorecard_sends;
drop index if exists public.monthly_scorecard_sends_org_company_month_idx;
drop table if exists public.monthly_scorecard_sends;

alter table public.companies drop column if exists monthly_scorecard;
