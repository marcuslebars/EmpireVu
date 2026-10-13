-- Rollback of 20261016100000_legacy_usage.sql (Everdoer rebrand: old-name usage counts).
-- The app keeps working without it (it falls back to console logging). The counts are lost, so
-- export them first if you still need the 30-day evidence:
--   \copy (select * from public.legacy_usage order by day, kind, key) to 'legacy_usage.csv' csv header
drop function if exists public.note_legacy_usage(text, text, text);
drop table if exists public.legacy_usage;
