-- ROLLBACK ONLY for supabase/migrations/20260804120000_add_billing.sql
--
-- Do NOT apply during normal deploys. This directory is not part of the forward
-- migration set (which is applied in filename order via the Supabase SQL editor —
-- see docs/EMPIREVU_RUNBOOK.md). Paste this only to undo the billing migration.
--
-- Drops the Phase 1 billing objects in reverse dependency order. Additive-only
-- guarantee: this restores organizations + the schema to its pre-billing state
-- and touches nothing that existed before the billing migration.

drop function if exists public.claim_billing_event_jobs(text, integer, integer);
drop function if exists public.record_billing_event(text, text, jsonb, uuid);

-- billing_event_jobs -> billing_events (FK), so drop the queue before the ledger.
drop table if exists public.billing_event_jobs;
drop table if exists public.feature_flags;
drop table if exists public.billing_events;
drop table if exists public.subscriptions;

-- organizations: drop the added constraints, then the added columns. (Dropping a
-- column would drop its constraints too; the explicit drops keep this readable
-- and order-independent.) billing_email is left untouched — it predates billing.
alter table public.organizations
  drop constraint if exists organizations_subscription_status_check,
  drop constraint if exists organizations_plan_check,
  drop constraint if exists organizations_stripe_customer_id_key;

alter table public.organizations
  drop column if exists trial_ends_at,
  drop column if exists subscription_status,
  drop column if exists plan,
  drop column if exists stripe_customer_id;
