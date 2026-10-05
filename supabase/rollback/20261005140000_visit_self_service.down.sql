-- Rollback for 20261005140000_visit_self_service.sql
drop index if exists public.bookings_manage_token_key;
alter table public.bookings drop column if exists manage_token;
alter table public.bookings drop column if exists customer_confirmed_at;
alter table public.companies drop column if exists visit_settings;
