-- Quick-setup intake delivery + enrichment bookkeeping (docs/done-for-you.md, "Intake & enrichment").
--
-- The intake text (and email backup) can fail at purchase time — Twilio blip, bad number.
-- The retry sweep needs to know how many tries it has had and which channel already went
-- out, so a retry never texts or emails the buyer twice. Enrichment likewise retries a
-- failed run a few times before leaving it for an operator.
--
-- Additive only; service role writes (nothing here is client-writable).
-- Rollback: supabase/rollback/20261008110000_setup_intake_delivery.down.sql

alter table public.setup_intakes
  add column if not exists send_attempts integer not null default 0,
  add column if not exists sms_sent_at timestamptz,
  add column if not exists email_sent_at timestamptz,
  add column if not exists enrich_attempts integer not null default 0;

comment on column public.setup_intakes.send_attempts is
  'How many times the setup link text/email has been tried (the retry sweep stops after a few).';
comment on column public.setup_intakes.enrich_attempts is
  'How many enrichment runs have been started for the current answers (reset on re-submit).';
