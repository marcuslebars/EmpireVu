-- Rollback for 20261011120000_staff_dispatcher.sql (the Dispatcher, docs/ai-staff.md).
drop index if exists public.activity_events_dispatch_idx;
drop table if exists public.dispatch_weather_cache;
drop table if exists public.dispatch_runs;
drop table if exists public.dispatch_messages;
alter table public.organization_memberships drop constraint if exists organization_memberships_phone_e164_format;
alter table public.organization_memberships drop column if exists phone_e164;
alter table public.companies drop column if exists location_checked_at;
alter table public.companies drop column if exists location_source;
alter table public.companies drop column if exists longitude;
alter table public.companies drop column if exists latitude;
