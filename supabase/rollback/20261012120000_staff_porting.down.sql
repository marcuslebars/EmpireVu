-- Rollback for 20261012120000_staff_porting.sql (Keep your number, docs/ai-staff.md).
--
-- Ported business lines stop routing: their voice_numbers rows are removed (the numbers stay in
-- the Twilio account; re-point their Voice URL by hand if they must keep ringing). The bucket's
-- files must be emptied first (Storage → porting-docs) or the bucket delete fails.
delete from public.voice_numbers where mode = 'business_line';
alter table public.voice_numbers drop constraint if exists voice_numbers_mode_check;
alter table public.voice_numbers
  add constraint voice_numbers_mode_check check (mode in ('ai_receptionist', 'missed_call_catcher', 'sms_only'));

drop table if exists public.business_line_calls;
drop table if exists public.number_port_requests;

delete from storage.buckets where id = 'porting-docs';
