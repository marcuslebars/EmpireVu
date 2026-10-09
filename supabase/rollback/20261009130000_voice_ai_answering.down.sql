drop table if exists public.call_answering_notices;
drop index if exists public.missed_calls_ai_retell_call_idx;
alter table public.missed_calls drop column if exists ai_urgent_alerted_at;
alter table public.missed_calls drop column if exists ai_followup_at;
alter table public.missed_calls drop column if exists ai_released_at;
alter table public.missed_calls drop column if exists ai_handoff_at;
alter table public.missed_calls drop column if exists ai_retell_call_id;
-- Rows in the AI states go back to the closest pre-AI meaning before the constraint narrows.
update public.missed_calls set text_back_status = 'suppressed' where text_back_status in ('ai_pending', 'ai_handled');
alter table public.missed_calls drop constraint if exists missed_calls_text_back_status_check;
alter table public.missed_calls
  add constraint missed_calls_text_back_status_check
  check (text_back_status in ('pending', 'emitted', 'suppressed', 'anonymous'));
