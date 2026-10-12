-- Rollback of 20261014110000_staff_customer_care.sql (Customer care & warranty).
-- companies.ai_settings.customer_care is left in place (unused once the code is gone). Pending
-- care_followup / warranty_claim approvals are withdrawn so a late "Y" can't land on a missing case.
-- Callback / warranty visits stay on the calendar as ordinary bookings; once care_case_bookings is
-- gone, invoices/auto.ts would treat them like any other job (check them by hand first).
update public.owner_approvals set status = 'superseded' where kind in ('care_followup', 'warranty_claim') and status = 'pending';
drop table if exists public.care_messages;
drop table if exists public.care_case_bookings;
drop table if exists public.care_cases;
drop table if exists public.care_checkins;
drop table if exists public.installed_equipment;
drop table if exists public.job_warranties;
drop table if exists public.warranty_terms;
