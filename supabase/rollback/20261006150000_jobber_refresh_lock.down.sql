-- Rollback for 20261006150000_jobber_refresh_lock.sql. Roll the app code back first:
-- the fixed ensureAccessToken calls this function.
drop function if exists public.claim_jobber_token_refresh(uuid, integer);
