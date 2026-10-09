-- Phase 1 wiring (docs/front-desk-ai.md): call_answering_notices is a server-only claim table
-- (one "AI minutes used up" notice per company per month, written and read only by the worker
-- with the service role — voice/jobs.ts). Nothing in the app reads it, so members lose the read
-- policy 20261009130000 gave them; it now matches owner_command_log / platform_sms_opt_outs
-- (service role only).
-- Rollback: supabase/rollback/20261009150000_front_desk_wiring.down.sql

drop policy if exists "call_answering_notices_select" on public.call_answering_notices;
revoke all on public.call_answering_notices from anon, authenticated;
