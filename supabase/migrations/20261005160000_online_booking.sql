-- Online booking upgrade: the public booking page books into the brand's real open times
-- (its booking windows, or its own bookable hours), lets the customer pick a service, and
-- can take a deposit through the brand's own invoice pay page before the slot is confirmed.
-- Rollback: supabase/rollback/20261005160000_online_booking.down.sql

-- Per brand: bookable hours, slot length, notice, services, auto-confirm, deposit (defaulted in code).
alter table public.companies add column if not exists online_booking_settings jsonb not null default '{}'::jsonb;

-- What was booked and what was paid up front.
alter table public.bookings add column if not exists service_item_id uuid references public.service_catalog_items (id) on delete set null;
-- The service's price when booked (flat-priced services), so the job's invoice starts from it.
alter table public.bookings add column if not exists price_cents integer check (price_cents is null or price_cents >= 0);
alter table public.bookings add column if not exists deposit_cents integer check (deposit_cents is null or deposit_cents >= 0);
-- The deposit is its own small invoice (no booking_id on it, so the job can still be invoiced);
-- the job's invoice later credits it.
alter table public.bookings add column if not exists deposit_invoice_id uuid references public.invoices (id) on delete set null;
alter table public.bookings add column if not exists deposit_paid_at timestamptz;
-- An online booking waiting for its deposit holds the slot until this time.
alter table public.bookings add column if not exists hold_expires_at timestamptz;

create index if not exists bookings_deposit_invoice_idx on public.bookings (deposit_invoice_id) where deposit_invoice_id is not null;
create index if not exists bookings_hold_expires_idx on public.bookings (hold_expires_at) where hold_expires_at is not null;
