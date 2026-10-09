alter table public.setup_intakes
  drop column if exists enrich_attempts,
  drop column if exists email_sent_at,
  drop column if exists sms_sent_at,
  drop column if exists send_attempts;
