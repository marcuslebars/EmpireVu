-- Rollback of 20261012110000_staff_importer.sql (customer import).
--
-- Contacts, past jobs (bookings) and balances (invoices) an import created are NOT removed — they
-- are ordinary records now (undo a batch from the import page first if you want them gone).
-- Imported balances lose their hold: run this only after the owner has said Y / N to them, or
-- they become ordinary overdue invoices (reminders_paused stays true on them, so nothing is
-- emailed or texted until someone un-pauses each one).
-- Uploaded files stay in the bucket; empty it in the dashboard (Storage → customer-imports)
-- first if you want them gone — a bucket with objects can't be dropped here.
-- companies.ai_settings.import is left in place (unused once the code is gone).

-- The accounting triggers as they were (20261005200000_accounting_sync.sql).
create or replace function public.accounting_enqueue_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'draft' then
    return new;
  end if;
  if tg_op = 'INSERT'
     or new.status is distinct from old.status and (new.status = 'void' or old.status = 'draft')
     or new.total_cents is distinct from old.total_cents
     or new.line_items is distinct from old.line_items
     or new.invoice_number is distinct from old.invoice_number
     or new.issue_date is distinct from old.issue_date
     or new.due_date is distinct from old.due_date
     or new.contact_id is distinct from old.contact_id
     or new.customer_account_id is distinct from old.customer_account_id
     or new.credit_cents is distinct from old.credit_cents
     or new.bill_to is distinct from old.bill_to then
    perform public.enqueue_accounting_sync(new.company_id, 'invoice', new.id);
  end if;
  return new;
end;
$$;

create or replace function public.accounting_enqueue_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status <> 'succeeded' then
    return new;
  end if;
  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.amount_cents is distinct from old.amount_cents
     or new.received_at is distinct from old.received_at
     or new.method is distinct from old.method then
    perform public.enqueue_accounting_sync(new.company_id, 'payment', new.id);
  end if;
  return new;
end;
$$;

drop index if exists public.contacts_import_batch_idx;
drop index if exists public.bookings_import_source_idx;
drop index if exists public.bookings_import_key_uniq;
drop index if exists public.invoices_import_hold_idx;
drop index if exists public.invoices_import_batch_idx;
drop index if exists public.invoices_import_key_uniq;
alter table public.invoices drop column if exists import_key;
alter table public.invoices drop column if exists import_hold;
alter table public.invoices drop column if exists import_batch_id;
alter table public.invoices drop column if exists imported_at;

drop table if exists public.import_rows;
drop table if exists public.import_batches;
drop table if exists public.import_links;

delete from storage.buckets where id = 'customer-imports' and not exists (select 1 from storage.objects where bucket_id = 'customer-imports');
