-- Rollback for 20261002130000_missed_call_catcher.sql
--
-- Drops the missed_calls table (its rows — caught calls + voicemail links — are lost; the
-- raw webhooks remain in inbound_webhook_jobs, and the leads/contacts/activity they created
-- are untouched).
--
-- voice_numbers: the 'twilio' provider + mode/provider_number_sid columns are removed. Any
-- provider='twilio' rows are DEACTIVATED (not deleted) and the old provider check is
-- re-added NOT VALID, so existing rows are kept but no new 'twilio' row can be inserted.
-- Release the Twilio numbers in the Twilio console if you are abandoning the feature.

drop table if exists public.missed_calls;

drop index if exists public.voice_numbers_company_mode_idx;

update public.voice_numbers set active = false where provider = 'twilio';

alter table public.voice_numbers drop constraint if exists voice_numbers_mode_check;
alter table public.voice_numbers drop column if exists mode;
alter table public.voice_numbers drop column if exists provider_number_sid;

alter table public.voice_numbers drop constraint if exists voice_numbers_provider_check;
alter table public.voice_numbers
  add constraint voice_numbers_provider_check check (provider in ('retell', 'telnyx')) not valid;
