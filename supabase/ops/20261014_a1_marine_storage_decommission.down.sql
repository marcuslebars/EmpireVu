-- Rollback for 20261014_a1_marine_storage_decommission.sql. Restores, from the backup table, only
-- the columns that script changed, and only on rows the backup holds. It leaves the backup
-- table in place; drop it yourself once you no longer need it:
--   drop table decommission.a1_marine_storage_20261014; drop schema decommission;

begin;

update public.companies c set
  stage = (b.before->>'stage')::public.company_stage,
  review_settings = b.before->'review_settings',
  invoice_settings = b.before->'invoice_settings',
  online_booking_settings = b.before->'online_booking_settings',
  digest = b.before->'digest',
  monthly_scorecard = b.before->'monthly_scorecard',
  ai_settings = b.before->'ai_settings',
  updated_at = now()
from decommission.a1_marine_storage_20261014 b
where b.tbl = 'companies' and b.id = c.id;

update public.workflows t set status = (b.before->>'status')::public.workflow_status, updated_at = now()
from decommission.a1_marine_storage_20261014 b where b.tbl = 'workflows' and b.id = t.id and t.status = 'paused';
update public.recurring_jobs t set status = b.before->>'status', updated_at = now()
from decommission.a1_marine_storage_20261014 b where b.tbl = 'recurring_jobs' and b.id = t.id and t.status = 'paused';
update public.review_requests t set status = b.before->>'status', updated_at = now()
from decommission.a1_marine_storage_20261014 b where b.tbl = 'review_requests' and b.id = t.id and t.status = 'cancelled';
update public.quotes t set status = b.before->>'status'
from decommission.a1_marine_storage_20261014 b where b.tbl = 'quotes' and b.id = t.id and t.status = 'cancelled';
update public.voice_numbers t set active = true
from decommission.a1_marine_storage_20261014 b where b.tbl = 'voice_numbers' and b.id = t.id;
update public.telnyx_numbers t set active = true, updated_at = now()
from decommission.a1_marine_storage_20261014 b where b.tbl = 'telnyx_numbers' and b.id = t.id;
update public.company_voice_profiles t set active = true, updated_at = now()
from decommission.a1_marine_storage_20261014 b where b.tbl = 'company_voice_profiles' and b.id = t.id;
update public.intake_keys t set active = true
from decommission.a1_marine_storage_20261014 b where b.tbl = 'intake_keys' and b.id = t.id;
update public.public_form_keys t set active = true
from decommission.a1_marine_storage_20261014 b where b.tbl = 'public_form_keys' and b.id = t.id;

commit;
