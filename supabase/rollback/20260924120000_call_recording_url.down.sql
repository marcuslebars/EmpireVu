-- Rollback for 20260924120000_call_recording_url.sql
alter table public.retell_calls drop column if exists recording_url;
