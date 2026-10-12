-- Rollback of 20261013130000_staff_purchasing.sql (Purchasing: suppliers, recipes, purchase orders).
-- companies.ai_settings.purchasing is left in place (unused once the code is gone). Pending
-- materials_order approvals are withdrawn so a late "Y" can't land on a missing order.
update public.owner_approvals set status = 'superseded' where kind = 'materials_order' and status = 'pending';
drop table if exists public.purchasing_daily_counts;
drop table if exists public.purchase_order_drafts;
drop table if exists public.purchase_orders;
drop table if exists public.material_recipes;
drop table if exists public.suppliers;
