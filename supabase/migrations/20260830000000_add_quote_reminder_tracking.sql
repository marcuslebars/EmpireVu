-- One reminder per quote, ever.
--
-- The expiry reminder is deliberately a SINGLE gentle nudge, not a drip
-- sequence. Without somewhere to record that it went out, a nightly cron would
-- re-send it every night for the five days before valid_until — which is exactly
-- the manufactured-urgency nagging the flow is meant to avoid, and the fastest
-- way to get a sending domain marked as spam.
--
-- This column IS the idempotency guard: the sweep filters on it being null and
-- sets it in the same UPDATE, so two overlapping runs cannot both send.

alter table public.quotes add column if not exists expiry_reminder_sent_at timestamptz;

-- Supports the reminder sweep: unapproved quotes approaching valid_until that
-- have not been reminded yet. Partial, so it stays small — the vast majority of
-- quotes are either already reminded or in a terminal state.
create index if not exists quotes_reminder_due_idx
  on public.quotes (expires_at)
  where expiry_reminder_sent_at is null and status in ('sent', 'viewed');
