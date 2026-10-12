-- Rollback for 20261013110000_staff_service_plans.sql (the AI staff: Service plans). Drops only
-- what it added.
--
-- Before running it, end the plan series by hand if you're also reverting the code, or they
-- become ordinary recurring jobs whose rule (yearly from the first visit) takes over:
--   update public.recurring_jobs set status = 'ended'
--    where id in (select recurring_job_id from public.service_agreements where recurring_job_id is not null);
-- Bookings already on the calendar, invoices and owner_approvals rows of kinds plan_signup /
-- plan_renewals stay (they're history).
drop table if exists public.service_plan_runs;
drop table if exists public.service_plan_messages;
drop table if exists public.service_agreements;
drop table if exists public.service_plans;
alter table public.recurring_jobs drop column if exists visit_dates;
