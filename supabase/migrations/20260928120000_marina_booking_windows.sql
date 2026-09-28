-- Marina books by HALF-DAY WINDOW, not by the hour (Marina-in-EmpireVu, PR 1b).
--
-- A mobile crew doesn't sell 60-minute slots: a shrink wrap is a 2–4 hour job and the
-- crew routes by area, so A1 Marine Care books "Tuesday morning" with a fixed number of
-- jobs per window. That is a per-company booking POLICY, stored here, and read by
-- Marina's check_availability / book tools. A company with no policy keeps today's
-- hourly public-booking behaviour untouched.
--
-- companies.booking_policy (jsonb, nullable):
--   {
--     "mode": "windows",
--     "windows": [
--       { "key": "morning",   "start": "09:00", "durationMinutes": 180, "spoken": "in the morning" },
--       { "key": "afternoon", "start": "13:00", "durationMinutes": 180, "spoken": "in the afternoon" }
--     ],
--     "capacityPerWindow": 2,     -- jobs per window, across ALL of the company's bookings
--     "leadTimeHours": 24,        -- soonest bookable
--     "horizonDays": 21,          -- how far ahead
--     "workingDays": [1,2,3,4,5,6] -- 0 = Sunday
--   }
-- Validated in code (src/server/services/booking-windows.ts); anything malformed falls
-- back to the defaults above rather than refusing to book.
--
-- bookings gains the links a phone booking needs:
--   quote_id        — the quote this job was booked against (deposit + follow-ups read it)
--   window_key      — which window, so capacity and "Tuesday morning" survive a reschedule
--   source          — 'marina' | 'public_booking' | 'app' …  (free text, for reporting)
--   source_call_id  — the Retell call that booked it; with quote_id, the idempotency key
--                     so a retried tool call never books the same caller twice.

alter table public.companies add column if not exists booking_policy jsonb;

alter table public.bookings add column if not exists quote_id uuid references public.quotes (id) on delete set null;
alter table public.bookings add column if not exists window_key text;
alter table public.bookings add column if not exists source text;
alter table public.bookings add column if not exists source_call_id text;

create index if not exists bookings_quote_id_idx on public.bookings (quote_id) where quote_id is not null;
create index if not exists bookings_company_scheduled_idx on public.bookings (company_id, scheduled_for);

create unique index if not exists bookings_quote_call_uniq
  on public.bookings (quote_id, source_call_id)
  where quote_id is not null and source_call_id is not null;

comment on column public.companies.booking_policy is
  'Per-company booking policy (half-day windows for mobile crews). NULL = default hourly slots. See booking-windows.ts.';
comment on column public.bookings.quote_id is 'The quote this booking was made against, if any.';
comment on column public.bookings.window_key is 'Booking window (e.g. morning / afternoon) for window-mode companies.';
comment on column public.bookings.source is 'Where the booking came from: marina, public_booking, app, import…';
comment on column public.bookings.source_call_id is 'Retell call id that created it; (quote_id, source_call_id) is unique.';
