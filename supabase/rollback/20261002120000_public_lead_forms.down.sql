-- Rollback for 20261002120000_public_lead_forms.sql
-- Leads already submitted through public forms stay in raw_leads / contacts; only the
-- key table goes. Embedded forms stop accepting submissions (404) once this runs.

drop table if exists public.public_form_keys;
