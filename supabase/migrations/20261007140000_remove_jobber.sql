-- Remove the Jobber integration (no longer used).
--
-- Drops the OAuth connection store (tokens), the sync job queue and its functions/type.
-- Data in Jobber itself is untouched. Any Jobber webhooks still sitting in the shared
-- inbound queue are closed out (not failed) so they don't raise operator-health alerts.
-- Rollback: supabase/rollback/20261007140000_remove_jobber.down.sql recreates the empty
-- structure only — tokens and job history are not recoverable.

update public.inbound_webhook_jobs
   set status = 'completed',
       last_error = 'Not processed: the Jobber integration was removed.',
       claimed_at = null,
       claimed_by = null
 where provider = 'jobber'
   and status in ('pending', 'running');

drop function if exists public.claim_jobber_token_refresh(uuid, integer);
drop function if exists public.claim_jobber_sync_jobs(text, integer, integer);
drop table if exists public.jobber_sync_jobs;
drop table if exists public.jobber_connections;
drop type if exists public.jobber_sync_job_status;
