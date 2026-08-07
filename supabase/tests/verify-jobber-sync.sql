-- Jobber sync schema + RLS verification.
--
-- Run in the Supabase SQL editor (or psql) against a project that has the Jobber
-- migration applied (supabase/migrations/20260807000000_add_jobber_sync.sql). It is
-- READ-ONLY / metadata-only: the DO-block assertions below RAISE on any failure and
-- touch no data. Run this right after applying the migration, before flipping
-- JOBBER_SYNC_ENABLED=1.
--
-- Migration up/down verification is procedural, not part of this script:
--   1. apply supabase/migrations/20260807000000_add_jobber_sync.sql          (up)
--   2. run this script                                                       (verify)
--   3. apply supabase/rollback/20260807000000_add_jobber_sync.down.sql       (down, if present)
--   4. re-apply the up migration                                            (up again)

-- ── tables + enum type exist ─────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.jobber_connections') is null then raise exception 'FAIL: jobber_connections missing'; end if;
  if to_regclass('public.jobber_sync_jobs') is null then raise exception 'FAIL: jobber_sync_jobs missing'; end if;
  if not exists (select 1 from pg_type where typname = 'jobber_sync_job_status') then
    raise exception 'FAIL: enum jobber_sync_job_status missing';
  end if;
  raise notice 'OK: jobber_connections + jobber_sync_jobs + status enum present';
end $$;

-- ── idempotency: exactly one sync job per lead (unique on lead_id) ────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobber_sync_jobs_lead_id_key') then
    raise exception 'FAIL: unique(lead_id) idempotency constraint missing on jobber_sync_jobs';
  end if;
  raise notice 'OK: jobber_sync_jobs unique(lead_id) idempotency constraint present';
end $$;

-- ── updated_at triggers wired ────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'jobber_connections_set_updated_at') then
    raise exception 'FAIL: jobber_connections updated_at trigger missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'jobber_sync_jobs_set_updated_at') then
    raise exception 'FAIL: jobber_sync_jobs updated_at trigger missing';
  end if;
  raise notice 'OK: updated_at triggers present on both tables';
end $$;

-- ── RLS enabled on both tables ───────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['jobber_connections', 'jobber_sync_jobs'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL: RLS not enabled on %', t;
    end if;
  end loop;
  raise notice 'OK: RLS enabled on jobber_connections + jobber_sync_jobs';
end $$;

-- ── policy shape: tokens are secret; jobs are read-only to org members ────────
do $$
begin
  -- jobber_connections holds OAuth access/refresh tokens: service-role ONLY,
  -- so it must have NO tenant policy (RLS on + no policy = deny-all to members).
  if exists (select 1 from pg_policies where tablename = 'jobber_connections') then
    raise exception 'FAIL: jobber_connections must have NO policies (tokens are service-role-only secrets)';
  end if;
  -- jobber_sync_jobs is readable by org members (ops / needs-attention view);
  -- all writes still go through the service-role admin client.
  if not exists (
    select 1 from pg_policies
    where tablename = 'jobber_sync_jobs' and policyname = 'jobber_sync_jobs_org_members_select'
  ) then
    raise exception 'FAIL: jobber_sync_jobs org-member SELECT policy missing';
  end if;
  if exists (
    select 1 from pg_policies
    where tablename = 'jobber_sync_jobs' and cmd <> 'SELECT'
  ) then
    raise exception 'FAIL: jobber_sync_jobs must expose no write policy to tenants (service-role writes only)';
  end if;
  raise notice 'OK: connections service-role-only; sync_jobs member-readable, no tenant writes';
end $$;

-- ── claim RPC exists + is granted to service_role ────────────────────────────
do $$
begin
  if to_regprocedure('public.claim_jobber_sync_jobs(text, integer, integer)') is null then
    raise exception 'FAIL: claim_jobber_sync_jobs RPC missing';
  end if;
  if not has_function_privilege('service_role', 'public.claim_jobber_sync_jobs(text, integer, integer)', 'execute') then
    raise exception 'FAIL: claim_jobber_sync_jobs not executable by service_role';
  end if;
  raise notice 'OK: claim_jobber_sync_jobs present + executable by service_role';
end $$;

do $$ begin raise notice 'ALL AUTOMATED JOBBER SYNC SCHEMA/RLS CHECKS PASSED'; end $$;
