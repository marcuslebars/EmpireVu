-- ROLLBACK ONLY — reverses 20260904120000_inbound_webhook_jobs.sql.
-- Apply by hand in the Supabase SQL editor if the inbound-webhook queue must be undone.

drop function if exists public.claim_inbound_webhook_jobs(integer, text, integer);
drop index if exists public.inbound_webhook_jobs_org_created_idx;
drop index if exists public.inbound_webhook_jobs_running_claimed_idx;
drop index if exists public.inbound_webhook_jobs_status_run_at_idx;
drop table if exists public.inbound_webhook_jobs;
