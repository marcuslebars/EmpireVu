-- Rollback for 20261004140000_help_support.sql
drop policy if exists "help_chat_events_members_insert" on public.help_chat_events;
drop policy if exists "help_chat_events_members_select" on public.help_chat_events;
drop index if exists public.help_chat_events_session_idx;
drop index if exists public.help_chat_events_org_created_idx;
drop table if exists public.help_chat_events;

drop policy if exists "support_requests_members_insert" on public.support_requests;
drop policy if exists "support_requests_members_select" on public.support_requests;
drop index if exists public.support_requests_org_created_idx;
drop table if exists public.support_requests;
