-- Rollback for 20260907120000_onboarding.sql
drop policy if exists "branding_public_read" on storage.objects;
delete from storage.buckets where id = 'branding';
drop table if exists public.onboarding_events;
drop table if exists public.onboarding_progress;
alter table public.companies drop column if exists service_area;
alter table public.companies drop column if exists hours;
