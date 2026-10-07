-- Half-finished invoice drafts: a draft may be saved before choosing who it's for.
-- Every issued invoice (sent, viewed, paid, void…) still needs a contact or a business
-- account; the app checks this — and lines, descriptions and a price — before sending.
-- Rollback: supabase/rollback/20261006120000_invoice_drafts.down.sql

do $$
declare
  c record;
begin
  -- The original unnamed check ("invoices_check"); found by its definition so a renamed
  -- copy is dropped too.
  for c in
    select conname from pg_constraint
     where conrelid = 'public.invoices'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%contact_id IS NOT NULL%customer_account_id IS NOT NULL%'
       and pg_get_constraintdef(oid) not ilike '%status%'
  loop
    execute format('alter table public.invoices drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.invoices drop constraint if exists invoices_customer_unless_draft;
alter table public.invoices
  add constraint invoices_customer_unless_draft
  check (status = 'draft' or contact_id is not null or customer_account_id is not null);
