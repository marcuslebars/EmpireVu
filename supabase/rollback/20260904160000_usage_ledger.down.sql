-- Rollback for 20260904160000_usage_ledger.sql

drop view if exists public.usage_monthly_v;
drop table if exists public.usage_events;

alter table public.retell_calls drop column if exists cost_breakdown;
alter table public.retell_calls drop column if exists call_cost_cents;
alter table public.retell_calls drop column if exists end_timestamp;
alter table public.retell_calls drop column if exists start_timestamp;
alter table public.retell_calls drop column if exists duration_ms;
