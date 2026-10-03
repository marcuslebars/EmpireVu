-- Rollback for 20261004150000_operator_health.sql
-- Drops the daily operator health send log. No tenant data is touched.

drop trigger if exists operator_health_reports_set_updated_at on public.operator_health_reports;
drop table if exists public.operator_health_reports;
