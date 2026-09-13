-- Rollback for 20260912120000_revenue_attribution.sql
drop function if exists public.ui_attribution_summary(uuid, uuid, timestamptz, timestamptz);
drop view if exists public.revenue_attribution_v;
drop index if exists public.quotes_org_company_paid_idx;
drop index if exists public.quotes_org_company_approved_idx;
drop index if exists public.workflow_runs_trigger_event_idx;
drop index if exists public.retell_calls_org_contact_idx;
drop index if exists public.raw_leads_org_contact_idx;
