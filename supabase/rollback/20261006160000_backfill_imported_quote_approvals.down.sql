-- Rollback for 20261006160000_backfill_imported_quote_approvals.sql: clears only the
-- snapshots that migration wrote (marked by its approved_by_name).
update public.quotes
   set approved_at = null,
       approved_by_name = null,
       approved_line_items = null,
       approved_subtotal_cents = null,
       approved_tax_cents = null,
       approved_total_cents = null,
       approved_deposit_cents = null
 where source = 'import:a1marinecare'
   and approved_by_name = 'Paid deposit on the previous site';
