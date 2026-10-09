-- Phase 1 / VOICE: "AI answers when you can't" on the missed-call catcher
-- (docs/front-desk-ai.md → "## Phone answering").
--
-- A call forwarded to a catcher number can now be handed to a Retell AI agent (TwiML
-- <Dial><Sip> to a call we registered with Retell). The per-call state lives on the existing
-- missed_calls row (one per Twilio CallSid), so the text-back, the voicemail fallback and the
-- AI hand-off can never double up:
--
--   text_back_status
--     'ai_pending'  the call was handed to the AI; NO generic text-back, NO call.missed.
--                   Resolved to 'ai_handled' by the post-call webhook, or released back to
--                   'pending' (→ the normal missed-call path) when the AI leg fails or the
--                   watchdog finds no post-call webhook.
--     'ai_handled'  the AI took the call; one follow-up text went (or was skipped) instead.
--   ai_retell_call_id      the Retell call id we registered (links retell_calls).
--   ai_handoff_at          when we handed the call over.
--   ai_released_at         when the AI leg failed and we fell back to voicemail + text-back.
--   ai_followup_at         claim for the single follow-up text to the caller.
--   ai_urgent_alerted_at   claim for the mid-call "urgent" owner alert.
--
-- call_answering_notices: one owner notice per company per month per kind (e.g. "your AI call
-- minutes for October are used up"). Service role only.
--
-- Additive. Members keep read access to missed_calls (existing policy); nothing here is
-- client-writable. Rollback: supabase/rollback/20261009130000_voice_ai_answering.down.sql

alter table public.missed_calls drop constraint if exists missed_calls_text_back_status_check;
alter table public.missed_calls
  add constraint missed_calls_text_back_status_check
  check (text_back_status in ('pending', 'emitted', 'suppressed', 'anonymous', 'ai_pending', 'ai_handled'));

alter table public.missed_calls add column if not exists ai_retell_call_id text;
alter table public.missed_calls add column if not exists ai_handoff_at timestamptz;
alter table public.missed_calls add column if not exists ai_released_at timestamptz;
alter table public.missed_calls add column if not exists ai_followup_at timestamptz;
alter table public.missed_calls add column if not exists ai_urgent_alerted_at timestamptz;

create index if not exists missed_calls_ai_retell_call_idx
  on public.missed_calls (ai_retell_call_id) where ai_retell_call_id is not null;

create table if not exists public.call_answering_notices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  company_id uuid not null,
  month date not null,
  kind text not null check (kind in ('minutes_exhausted')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, month, kind),
  foreign key (company_id, organization_id)
    references public.companies (id, organization_id) on delete cascade
);

alter table public.call_answering_notices enable row level security;
drop policy if exists "call_answering_notices_select" on public.call_answering_notices;
create policy "call_answering_notices_select" on public.call_answering_notices
  for select using (public.is_organization_member(organization_id));
revoke insert, update, delete on public.call_answering_notices from anon, authenticated;
revoke select on public.call_answering_notices from anon;
