-- Rollback for 20261005160000_online_booking.sql
drop index if exists public.bookings_hold_expires_idx;
drop index if exists public.bookings_deposit_invoice_idx;
alter table public.bookings drop column if exists hold_expires_at;
alter table public.bookings drop column if exists deposit_paid_at;
alter table public.bookings drop column if exists deposit_invoice_id;
alter table public.bookings drop column if exists deposit_cents;
alter table public.bookings drop column if exists price_cents;
alter table public.bookings drop column if exists service_item_id;
alter table public.companies drop column if exists online_booking_settings;
