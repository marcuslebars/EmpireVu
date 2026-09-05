-- Rollback for 20260904180000_multitenant_edges.sql
-- telnyx_numbers was never dropped, so the Telnyx path reverts cleanly.

drop table if exists public.voice_numbers;
drop table if exists public.intake_keys;
