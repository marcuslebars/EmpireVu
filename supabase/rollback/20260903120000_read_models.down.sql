-- ROLLBACK ONLY — reverses 20260903120000_read_models.sql.
-- Apply by hand in the Supabase SQL editor if the read-model migration must be undone.
-- Drops the views, functions, indexes and the generated search column. Leaves the
-- pg_trgm extension in place (harmless, and other objects may come to depend on it).

-- Detail RPCs
drop function if exists public.ui_workflow_detail(uuid, uuid);
drop function if exists public.ui_task_detail(uuid, uuid);
drop function if exists public.ui_contact_detail(uuid, uuid);

-- List views
drop view if exists public.ui_contact_list_v;
drop view if exists public.ui_workflow_jobs_v;
drop view if exists public.ui_workflow_list_v;
drop view if exists public.ui_task_list_v;

-- List/summary functions
drop function if exists public.ui_calendar_bookings(uuid, uuid, timestamptz, timestamptz);
drop function if exists public.ui_activity_feed(uuid, uuid, integer, timestamptz);
drop function if exists public.ui_automation_impact(uuid, uuid, timestamptz);
drop function if exists public.ui_dashboard_summary(uuid, uuid);

-- Revenue helper
drop function if exists public.ui_value_cents(jsonb);

-- Indexes
drop index if exists public.quotes_contact_status_idx;
drop index if exists public.tasks_contact_status_idx;
drop index if exists public.bookings_contact_scheduled_idx;
drop index if exists public.activity_events_company_occurred_idx;
drop index if exists public.activity_events_related_entity_occurred_idx;
drop index if exists public.activity_events_entity_occurred_idx;

-- Search
drop index if exists public.contacts_search_text_trgm_idx;
alter table public.contacts drop column if exists search_text;
