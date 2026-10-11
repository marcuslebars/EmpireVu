-- Rollback of 20261011110000_staff_bookkeeper.sql (the AI Bookkeeper's tables).
-- companies.ai_settings.collections is left in place (unused once the code is gone).
drop table if exists public.money_alert_items;
drop table if exists public.money_alerts;
drop table if exists public.payment_plans;
drop table if exists public.invoice_reminder_texts;
drop table if exists public.invoice_collections;
