-- Imported quotes whose deposit was paid on the previous (A1 Marine Care) site.
--
-- The import set status = 'deposit_paid' and deposit_paid_at, but nothing froze the
-- approval snapshot (approved_at / approved_line_items / approved_* totals) — paying
-- there happened outside EmpireVu's approve step. Invoicing now bills ONLY from that
-- snapshot, so these quotes were refused with "hasn't been approved by the customer".
--
-- Paying the deposit was the customer's acceptance, so the snapshot is filled from
-- each quote's own stored lines and totals (the amounts it was imported at). The
-- import job does the same for new imports from now on.
--
-- Additive and idempotent: only touches imported, paid rows with no approval yet.
-- Rollback: supabase/rollback/20261006160000_backfill_imported_quote_approvals.down.sql

update public.quotes
   set approved_at             = deposit_paid_at,
       approved_by_name        = 'Paid deposit on the previous site',
       approved_line_items     = line_items,
       approved_subtotal_cents = subtotal_cents,
       approved_tax_cents      = tax_cents,
       approved_total_cents    = total_cents,
       approved_deposit_cents  = deposit_cents
 where source = 'import:a1marinecare'
   and status in ('deposit_paid', 'completed')
   and deposit_paid_at is not null
   and approved_at is null
   and approved_line_items is null;
