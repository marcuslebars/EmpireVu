-- Rollback for 20261004190000_timesheets_costing.sql. Destroys all time entries, materials and pay rates.
drop function if exists public.close_job_time_entries(uuid);
drop table if exists public.member_pay_rates;
drop table if exists public.job_materials;
drop table if exists public.time_entries;
