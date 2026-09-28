-- Rollback for 20260928120000_marina_booking_windows.sql
drop index if exists public.bookings_quote_call_uniq;
drop index if exists public.bookings_company_scheduled_idx;
drop index if exists public.bookings_quote_id_idx;
alter table public.bookings drop column if exists source_call_id;
alter table public.bookings drop column if exists source;
alter table public.bookings drop column if exists window_key;
alter table public.bookings drop column if exists quote_id;
alter table public.companies drop column if exists booking_policy;
