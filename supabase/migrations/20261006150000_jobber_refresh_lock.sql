-- Jobber token refresh lock, taken in SQL.
--
-- ensureAccessToken used to take its refresh lock with a PostgREST PATCH filtered by
-- `or=(refresh_lock_at.is.null,refresh_lock_at.lt.<stale>)` + return=representation.
-- PostgREST re-applies that filter to the RETURNED row, whose refresh_lock_at is now
-- "now" — so the update succeeded but returned [] and the caller always concluded
-- someone else held the lock, waited 10s and failed. Net effect: Jobber sync stopped
-- working about an hour after each connect (when the first access token expired).
--
-- This function does the conditional update in one statement and reports whether this
-- caller won. Service role only.
create or replace function public.claim_jobber_token_refresh(
  p_organization_id uuid,
  p_stale_after_seconds integer default 30
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.jobber_connections
     set refresh_lock_at = now()
   where organization_id = p_organization_id
     and (refresh_lock_at is null
          or refresh_lock_at < now() - make_interval(secs => greatest(p_stale_after_seconds, 1)));
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.claim_jobber_token_refresh(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_jobber_token_refresh(uuid, integer) to service_role;
