-- Rollback for 20261006140000_stripe_bank_debit_capability.sql. Bank debit is then
-- gated on card readiness alone again (only if the app is rolled back too).
alter table public.companies drop column if exists stripe_acss_debit_enabled;
