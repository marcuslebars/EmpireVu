-- Re-add 'no_show' to the booking_status enum so bookings can be marked no-show.
-- (The original enum had it; the 2026-03-22 hardening migration recreated the
--  enum without it. This restores it additively.)
-- Note: ALTER TYPE ... ADD VALUE must run outside a transaction block — apply this
-- statement on its own in the Supabase SQL Editor.
alter type public.booking_status add value if not exists 'no_show';
