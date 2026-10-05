-- Rollback for 20261005120000_review_requests.sql
drop function if exists public.record_review_click(text);
drop table if exists public.review_requests;
alter table public.companies drop column if exists review_settings;
