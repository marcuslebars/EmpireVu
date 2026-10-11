-- Rollback of 20261012100000_staff_office_manager.sql (the AI Office manager's morning briefing).
-- companies.ai_settings.office_manager is left in place (unused once the code is gone). Once the
-- code is gone the Bookkeeper's 8am money alert goes out on its own again.
drop table if exists public.owner_briefings;
