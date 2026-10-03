-- Rollback for 20261004120000_forwarding_verification.sql
--
-- Drops forwarding_tests (the test-call history is lost; nothing else references it) and the
-- three voice_numbers verification columns. Features that read
-- voice_numbers.forwarding_verified_at / forwarding_last_test_result must be rolled back
-- first. Any queued inbound_webhook_jobs with provider='twilio_forwarding_test' will
-- dead-letter after the code is rolled back (unknown provider) — harmless.

drop table if exists public.forwarding_tests;

alter table public.voice_numbers drop constraint if exists voice_numbers_forwarding_last_test_result_check;
alter table public.voice_numbers drop column if exists forwarding_last_test_result;
alter table public.voice_numbers drop column if exists forwarding_last_test_at;
alter table public.voice_numbers drop column if exists forwarding_verified_at;
