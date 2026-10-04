-- Rollback for 20261004200000_customer_portal.sql. Every portal link stops working.
drop table if exists public.customer_portal_links;
