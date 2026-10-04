-- Rollback for 20261004180000_recurring_jobs.sql. Visits already created stay as ordinary bookings.
drop index if exists public.bookings_recurring_occurrence_key;
alter table public.bookings drop column if exists recurrence_exception;
alter table public.bookings drop column if exists occurrence_date;
alter table public.bookings drop column if exists recurring_job_id;
drop table if exists public.recurring_jobs;
