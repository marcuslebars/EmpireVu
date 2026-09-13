-- Rollback for 20260906170000_conversation_inbox.sql
drop function if exists public.ui_conversation_thread(uuid, uuid, timestamptz, integer);
drop view if exists public.ui_inbox_v;
drop table if exists public.contact_read_state;
