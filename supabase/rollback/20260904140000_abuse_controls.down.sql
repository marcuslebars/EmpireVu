-- Rollback for 20260904140000_abuse_controls.sql

drop function if exists public.consume_rate_limit(text, integer, integer);
drop index if exists public.rate_limit_buckets_window_idx;
drop table if exists public.rate_limit_buckets;
