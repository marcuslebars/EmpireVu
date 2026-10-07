-- Bank debit (Canadian pre-authorized debit / ACSS) is a separate Stripe capability.
--
-- A connected account can take cards (charges_enabled) without being able to take
-- ACSS debits: the `acss_debit_payments` capability has to be requested and approved
-- on its own. Until now the app offered bank debit whenever cards worked and the
-- brand had ticked "Bank debit" in its invoice settings, so a customer could pick it
-- and hit a Stripe error at checkout.
--
-- Mirrored from account.updated webhooks (and the Payments "refresh" action) like the
-- other capability columns: true only while capabilities.acss_debit_payments is
-- 'active'. Defaults to false, so bank debit stays hidden until Stripe reports it.
-- Rollback: supabase/rollback/20261006140000_stripe_bank_debit_capability.down.sql

alter table public.companies
  add column if not exists stripe_acss_debit_enabled boolean not null default false;
