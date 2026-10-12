-- Rollback of 20261014130000_staff_fleet.sql (Fleet & equipment: vehicles, equipment, rentals).
-- companies.ai_settings.fleet is left in place (unused once the code is gone). Fleet adds no
-- approval kinds, so there is nothing pending to withdraw.
drop table if exists public.fleet_reminders;
drop table if exists public.fleet_log;
drop table if exists public.rentals;
drop table if exists public.equipment;
drop table if exists public.vehicle_service_items;
drop table if exists public.vehicles;
