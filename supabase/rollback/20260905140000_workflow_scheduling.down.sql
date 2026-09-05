-- Rollback for 20260905140000_workflow_scheduling.sql
-- Note: a Postgres enum value ('waiting') cannot be dropped; it is left in place (harmless).

drop function if exists public.claim_workflow_schedule_ticks(integer, text, integer);
drop function if exists public.claim_waiting_workflow_runs(integer, integer);
drop table if exists public.workflow_schedule_ticks;

drop index if exists public.workflow_runs_status_resume_idx;
alter table public.workflow_runs drop column if exists resume_at;
alter table public.workflow_runs drop column if exists current_step_index;

alter table public.companies drop column if exists timezone;
