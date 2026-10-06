-- Rollback for 20261005200000_accounting_sync.sql. Drops every accounting connection,
-- token, link and queued job. Nothing in QuickBooks / Xero is touched; reconnecting later
-- starts with no links, so re-syncing an already-synced record would create it again —
-- set the start date past what's already there.
drop trigger if exists invoices_accounting_sync on public.invoices;
drop trigger if exists invoice_payments_accounting_sync on public.invoice_payments;
drop trigger if exists expenses_accounting_sync on public.expenses;
drop function if exists public.accounting_enqueue_invoice();
drop function if exists public.accounting_enqueue_payment();
drop function if exists public.accounting_enqueue_expense();
drop function if exists public.claim_accounting_sync_jobs(integer, integer);
drop function if exists public.claim_accounting_token_refresh(uuid, integer);
drop function if exists public.enqueue_accounting_sync(uuid, text, uuid);
drop table if exists public.accounting_sync_jobs;
drop table if exists public.accounting_links;
drop table if exists public.accounting_tokens;
drop table if exists public.accounting_connections;
