-- Confirm & reschedule: every booking gets a private link (/v/{manage_token}) the customer
-- can use to confirm the visit, move it to another open time, or cancel it — up to a
-- per-brand cutoff. Reminder texts carry it as {{booking.manage_url}}.
-- Rollback: supabase/rollback/20261005140000_visit_self_service.down.sql

-- 32 hex chars from a v4 UUID (122 random bits). The default is volatile, so every
-- existing booking gets its own token when the column is added, and every new one too.
alter table public.bookings
  add column if not exists manage_token text default replace(gen_random_uuid()::text, '-', '');
alter table public.bookings
  add column if not exists customer_confirmed_at timestamptz;

create unique index if not exists bookings_manage_token_key on public.bookings (manage_token);

-- Per brand: { allowReschedule, allowCancel, cutoffHours } (defaulted in code).
alter table public.companies add column if not exists visit_settings jsonb not null default '{}'::jsonb;
