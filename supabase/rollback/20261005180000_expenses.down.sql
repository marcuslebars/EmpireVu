-- Rollback for 20261005180000_expenses.sql. Destroys every expense record.
-- Receipt files stay in the bucket; empty it in the dashboard (Storage → expense-receipts)
-- before this if you want them gone, since a bucket with objects can't be dropped here.
drop function if exists public.mark_expenses_billed(uuid, uuid[]);
drop function if exists public.billable_expenses_for_booking(uuid);
drop table if exists public.expenses;
delete from storage.buckets where id = 'expense-receipts' and not exists (select 1 from storage.objects where bucket_id = 'expense-receipts');
