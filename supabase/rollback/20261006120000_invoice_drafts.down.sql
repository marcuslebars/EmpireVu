-- Rollback for 20261006120000_invoice_drafts.sql. Fails if a draft with no customer
-- exists — give those drafts a customer (or delete them) first.
alter table public.invoices drop constraint if exists invoices_customer_unless_draft;
alter table public.invoices
  add constraint invoices_check check (contact_id is not null or customer_account_id is not null);
