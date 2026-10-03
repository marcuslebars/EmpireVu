-- Rollback for 20261004120000_invoices.sql. Destroys all invoice data.
drop function if exists public.refresh_invoice_balance(uuid);
drop function if exists public.next_invoice_number(uuid);
drop table if exists public.invoice_number_counters;
drop table if exists public.invoice_events;
drop table if exists public.invoice_payments;
drop table if exists public.invoices;
alter table public.contacts drop constraint if exists contacts_customer_account_fk;
drop index if exists public.contacts_customer_account_idx;
alter table public.contacts drop column if exists customer_account_id;
drop table if exists public.customer_accounts;
alter table public.companies drop column if exists invoice_settings;
alter table public.companies drop column if exists business_address;
alter table public.companies drop column if exists tax_registration_number;
