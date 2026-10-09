-- Phase 1 AGENT: the AI that texts customers (docs/front-desk-ai.md, "Text conversations").
--
-- 1. One turn at a time per conversation: a short lease (lock_until / lock_token) taken with a
--    conditional update, so two texts in a row never produce two parallel replies.
-- 2. last_handled_inbound_at: the newest customer text a finished turn has answered — a queue
--    retry of an already-answered text is a no-op, and texts that arrive mid-turn are picked up.
-- 3. message_log.sent_by: who wrote an outbound message ('sms_agent' = the AI), so the inbox can
--    label AI messages "Assistant" and the agent can tell its own words from staff replies.
-- 4. owner_approvals.execution_claimed_at: executeApprovedAction runs each approval once.
--
-- Additive only; server (service role) writes. Rollback: supabase/rollback/20261009110000_sms_agent.down.sql

alter table public.sms_conversations
  add column if not exists lock_until timestamptz not null default '1970-01-01T00:00:00Z',
  add column if not exists lock_token uuid,
  add column if not exists last_handled_inbound_at timestamptz;
comment on column public.sms_conversations.lock_until is
  'SMS agent turn lease: a turn runs only after a conditional update moves this into the future. Epoch = free.';
comment on column public.sms_conversations.last_handled_inbound_at is
  'created_at of the newest inbound text a completed AI turn answered (idempotency + mid-turn pickup).';

alter table public.message_log
  add column if not exists sent_by text;
comment on column public.message_log.sent_by is
  'Who wrote an outbound message: sms_agent (the AI front desk), or null (staff / automation).';
create index if not exists message_log_sent_by_idx
  on public.message_log (company_id, created_at desc) where sent_by is not null;

alter table public.owner_approvals
  add column if not exists execution_claimed_at timestamptz;
comment on column public.owner_approvals.execution_claimed_at is
  'Set (conditionally, once) when executeApprovedAction starts running the decision — makes it idempotent.';
