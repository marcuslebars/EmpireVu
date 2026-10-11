-- Rollback for 20261012120000_staff_porting.sql (Keep your number, docs/ai-staff.md).
--
-- Ported business lines keep working: their voice_numbers rows become catcher rows, so the
-- catcher path (AI answering / voicemail + text-back, inbound SMS) still resolves the company.
-- With the app code rolled back too, re-point each ported number's Voice URL in Twilio from
-- /api/twilio/voice/business-line to /api/twilio/voice/inbound (the business-line route is gone).
-- The bucket's files must be emptied first (Storage → porting-docs) or the bucket delete fails.
update public.voice_numbers set mode = 'missed_call_catcher' where mode = 'business_line';
alter table public.voice_numbers drop constraint if exists voice_numbers_mode_check;
alter table public.voice_numbers
  add constraint voice_numbers_mode_check check (mode in ('ai_receptionist', 'missed_call_catcher', 'sms_only'));

drop table if exists public.business_line_calls;
drop table if exists public.number_port_requests;

delete from storage.buckets where id = 'porting-docs';
