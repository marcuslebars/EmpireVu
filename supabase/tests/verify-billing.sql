-- Billing schema + RLS verification.
--
-- Run in the Supabase SQL editor (or psql) against a project that has the billing
-- migration applied (supabase/migrations/20260804120000_add_billing.sql). It is
-- READ-ONLY / metadata-only: the automated DO-block assertions below RAISE on any
-- failure and touch no data. A final commented section is an interactive template
-- for the full row-level "org A cannot read org B" check, which needs a real
-- authenticated user (auth.uid()).
--
-- Migration up/down verification is procedural, not part of this script:
--   1. apply supabase/migrations/20260804120000_add_billing.sql          (up)
--   2. run this script                                                   (verify)
--   3. apply supabase/rollback/20260804120000_add_billing.down.sql       (down)
--   4. re-apply the up migration                                         (up again)
-- Steps 1, 3, 4 must each complete without error (clean up/down/up).

-- ── tables + columns exist ───────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.subscriptions') is null then raise exception 'FAIL: subscriptions missing'; end if;
  if to_regclass('public.billing_events') is null then raise exception 'FAIL: billing_events missing'; end if;
  if to_regclass('public.billing_event_jobs') is null then raise exception 'FAIL: billing_event_jobs missing'; end if;
  if to_regclass('public.feature_flags') is null then raise exception 'FAIL: feature_flags missing'; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations'
      and column_name in ('stripe_customer_id', 'plan', 'subscription_status', 'trial_ends_at')
    group by table_name having count(*) = 4
  ) then
    raise exception 'FAIL: organizations is missing one of the billing columns';
  end if;

  raise notice 'OK: billing tables + organizations columns present';
end $$;

-- ── check constraints on organizations ───────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_plan_check') then
    raise exception 'FAIL: organizations_plan_check missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_subscription_status_check') then
    raise exception 'FAIL: organizations_subscription_status_check missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'organizations_stripe_customer_id_key') then
    raise exception 'FAIL: organizations_stripe_customer_id_key (unique) missing';
  end if;
  raise notice 'OK: organizations check + unique constraints present';
end $$;

-- ── RLS enabled on all new tenant tables ─────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['subscriptions', 'billing_events', 'billing_event_jobs', 'feature_flags'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'FAIL: RLS not enabled on %', t;
    end if;
  end loop;
  raise notice 'OK: RLS enabled on subscriptions, billing_events, billing_event_jobs, feature_flags';
end $$;

-- ── the org-member SELECT policies exist ─────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'subscriptions' and policyname = 'subscriptions_org_members_select') then
    raise exception 'FAIL: subscriptions select policy missing';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'billing_events' and policyname = 'billing_events_org_members_select') then
    raise exception 'FAIL: billing_events select policy missing';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'feature_flags' and policyname = 'feature_flags_org_members_select') then
    raise exception 'FAIL: feature_flags select policy missing';
  end if;
  -- billing_event_jobs is service-role only: RLS on, but NO tenant policy.
  if exists (select 1 from pg_policies where tablename = 'billing_event_jobs') then
    raise exception 'FAIL: billing_event_jobs should have no tenant policies (service-role only)';
  end if;
  raise notice 'OK: tenant SELECT policies present; billing_event_jobs is service-role only';
end $$;

-- ── billing_events.payload is service-role only (column privilege) ────────────
-- The raw payload must NOT be granted to tenant roles; the metadata columns must.
do $$
begin
  if exists (
    select 1 from information_schema.column_privileges
    where table_name = 'billing_events' and column_name = 'payload'
      and grantee in ('anon', 'authenticated') and privilege_type = 'SELECT'
  ) then
    raise exception 'FAIL: billing_events.payload is SELECT-able by a tenant role';
  end if;

  if not exists (
    select 1 from information_schema.column_privileges
    where table_name = 'billing_events' and column_name = 'type'
      and grantee = 'authenticated' and privilege_type = 'SELECT'
  ) then
    raise exception 'FAIL: billing_events.type should be SELECT-able by authenticated';
  end if;

  raise notice 'OK: billing_events.payload denied to tenants; metadata columns granted';
end $$;

-- ── RPCs exist ───────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.record_billing_event(text, text, jsonb, uuid)') is null then
    raise exception 'FAIL: record_billing_event RPC missing';
  end if;
  if to_regprocedure('public.claim_billing_event_jobs(text, integer, integer)') is null then
    raise exception 'FAIL: claim_billing_event_jobs RPC missing';
  end if;
  raise notice 'OK: record_billing_event + claim_billing_event_jobs present';
end $$;

do $$ begin raise notice 'ALL AUTOMATED BILLING SCHEMA/RLS CHECKS PASSED'; end $$;

-- ── Interactive row-isolation check (org A cannot read org B) ─────────────────
-- Requires a real authenticated user; run manually against a scratch project.
-- Replace <USER_A_UUID> (a member of ORG_A only), <ORG_A>, <ORG_B> with real ids.
-- Wrap in a transaction and ROLLBACK so nothing persists.
--
-- begin;
--   -- seed two orgs + one subscription each (ORG_A, ORG_B), one feature_flag each,
--   -- and one billing_events row each (organization_id = ORG_A / ORG_B).
--
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('sub', '<USER_A_UUID>')::text, true);
--
--   -- EXPECT: only ORG_A's rows are visible.
--   select organization_id from public.subscriptions;   -- expect: only ORG_A
--   select organization_id from public.feature_flags;   -- expect: only ORG_A
--   select organization_id from public.billing_events;  -- expect: only ORG_A (never ORG_B, never null-org)
--   -- EXPECT: permission denied for column "payload"
--   select payload from public.billing_events;
--
--   reset role;
-- rollback;
