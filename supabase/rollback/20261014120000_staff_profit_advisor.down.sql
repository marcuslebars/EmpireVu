-- Rollback of 20261014120000_staff_profit_advisor.sql (Profit advisor: price changes, sweep claims).
-- companies.ai_settings.profit_advisor is left in place (unused once the code is gone). Pending
-- price_change approvals are withdrawn so a late "Y" can't land on a missing row. Prices already
-- raised stay as they are on the price list (they're the owner's approved prices).
update public.owner_approvals set status = 'superseded' where kind = 'price_change' and status = 'pending';
drop table if exists public.profit_advisor_runs;
drop table if exists public.price_changes;
