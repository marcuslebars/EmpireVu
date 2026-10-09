alter table public.owner_approvals drop column if exists execution_claimed_at;
drop index if exists public.message_log_sent_by_idx;
alter table public.message_log drop column if exists sent_by;
alter table public.sms_conversations
  drop column if exists last_handled_inbound_at,
  drop column if exists lock_token,
  drop column if exists lock_until;
