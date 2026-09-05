-- Rollback for 20260905120000_messaging_consent.sql

drop table if exists public.message_log;

alter table public.companies drop column if exists owner_phone_e164;
alter table public.companies drop column if exists owner_email;

alter table public.contacts drop column if exists consent_source;
alter table public.contacts drop column if exists email_opt_out_at;
alter table public.contacts drop column if exists sms_opt_out_at;
alter table public.contacts drop column if exists sms_consent_at;
