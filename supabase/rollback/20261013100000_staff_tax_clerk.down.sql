-- Rollback for 20261013100000_staff_tax_clerk.sql (the AI Tax Clerk: receipts by text + HST).
-- Drops only what it added. Expenses filed from texted receipts are ordinary expenses and stay
-- (their pictures stay in expense-receipts); owner_approvals rows of kind accountant_packet are
-- history and stay too. Pictures of receipts still waiting for review (receipt_texts with
-- status needs_review) lose their row: list them first if you need them
--   select file_path from public.receipt_texts where status = 'needs_review';
drop table if exists public.tax_clerk_notices;
drop table if exists public.hst_periods;
drop table if exists public.receipt_texts;
