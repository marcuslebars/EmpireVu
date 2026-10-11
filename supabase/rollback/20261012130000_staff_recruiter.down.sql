-- Rollback for 20261012130000_staff_recruiter.sql (the AI Recruiter: hiring & payroll). Drops
-- only what it added. owner_approvals rows of kinds payroll_period / job_post / interview_invite
-- are left in place (they're history); their executors are gone once the code is reverted.
-- Contacts created for applicants (metadata.kind = 'applicant') are ordinary contacts and stay.
drop trigger if exists time_entries_pay_period_lock on public.time_entries;
drop function if exists public.time_entries_enforce_pay_period_lock();
drop function if exists public.time_entry_in_locked_period(uuid, uuid, timestamptz);
drop table if exists public.recruiter_sweep_claims;
drop table if exists public.job_applicants;
drop table if exists public.job_postings;
drop table if exists public.pay_period_events;
drop table if exists public.pay_periods;
