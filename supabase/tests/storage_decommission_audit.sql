-- READ-ONLY: everything still live for A1 Marine Storage (being decommissioned, 2026-10-14).
-- Paste into the Supabase SQL editor. SELECTs only; one statement, so the editor shows every row.
-- Sections 28–36 read tables from the 20261011–20261014 AI-staff migrations; if one of those isn't
-- applied in this project, delete that branch of the UNION.
-- Not visible here (check Railway → EmpireVu (web) + worker env): RETELL_SOURCE_SITE (defaults to
-- "a1marinestorage": unmatched Retell calls are filed as Storage leads), TELNYX_DEFAULT_TENANT_ID,
-- OUTBOUND_FROM_EMAIL and QUOTE_PUBLIC_BASE_URL (both on the a1marinestorage.ca domain per
-- docs/empirevu-hub-setup.md — A1 Marine Care's mail and quote links depend on that domain).
with org as (
  select o.id, o.slug, o.name, o.plan, o.platform_brand, o.crankleads_tier, o.subscription_status
  from public.organizations o where o.slug = 'a1-group'
),
co as (
  select c.* from public.companies c join org on org.id = c.organization_id
  where c.name ilike 'A1 Marine Storage%'
),
wf as (select w.* from public.workflows w join co on co.id = w.company_id)
select section, item, detail from (
  select '00 company'::text as section, co.id::text as item,
    jsonb_build_object('name',co.name,'slug',co.slug,'stage',co.stage,'timezone',co.timezone,
      'owner_phone_e164',co.owner_phone_e164,'owner_phone_verified_at',co.owner_phone_verified_at,
      'owner_email',co.owner_email,'website',co.website,'brand_review_url',co.brand_review_url,
      'quote_public_base_url',co.quote_public_base_url) as detail
  from co
  union all
  select '01 organization', org.id::text,
    jsonb_build_object('slug',org.slug,'name',org.name,'plan',org.plan,'platform_brand',org.platform_brand,
      'crankleads_tier',org.crankleads_tier,'subscription_status',org.subscription_status,
      'storage_companies_matched',(select count(*) from co))
  from org
  union all
  select '02 stripe connect', co.id::text,
    jsonb_build_object('stripe_connected_account_id',co.stripe_connected_account_id,'stripe_account_label',co.stripe_account_label,
      'stripe_mode',co.stripe_mode,'charges_enabled',co.stripe_charges_enabled,'payouts_enabled',co.stripe_payouts_enabled,
      'details_submitted',co.stripe_details_submitted,'acss_debit_enabled',co.stripe_acss_debit_enabled,
      'connect_updated_at',co.stripe_connect_updated_at,
      'can_take_payments_now',(co.stripe_connected_account_id is not null and co.stripe_charges_enabled))
  from co
  union all
  select '03 company switches (code defaults applied)', co.id::text,
    jsonb_build_object(
      'online_booking_enabled', case when jsonb_typeof(co.online_booking_settings->'enabled')='boolean' then (co.online_booking_settings->>'enabled')::boolean else true end,
      'public_booking_path', '/book/'||co.id::text,
      'review_requests_enabled', case when jsonb_typeof(co.review_settings->'enabled')='boolean' then (co.review_settings->>'enabled')::boolean else false end,
      'invoice_email_reminders_enabled', case when jsonb_typeof(co.invoice_settings->'remindersEnabled')='boolean' then (co.invoice_settings->>'remindersEnabled')::boolean else true end,
      'owner_daily_digest_enabled', coalesce(co.digest->'enabled' = 'true'::jsonb, false),
      'monthly_scorecard_enabled', coalesce(co.monthly_scorecard->'enabled' <> 'false'::jsonb, true),
      'visit_settings', co.visit_settings,
      'has_booking_policy', co.booking_policy is not null,
      'owner_paused_texts', co.ai_settings ? 'owner_pause')
  from co
  union all
  select '04 ai_settings.'||s.key, co.id::text, s.value
  from co cross join lateral jsonb_each(co.ai_settings) s
  union all
  select '05 workflows active (Storage)', wf.id::text,
    jsonb_build_object('name',wf.name,'slug',wf.slug,'trigger_event',wf.trigger_event)
  from wf where wf.status = 'active'
  union all
  select '06 workflows active (org-wide, also fire for Storage)', w.id::text,
    jsonb_build_object('name',w.name,'slug',w.slug,'trigger_event',w.trigger_event)
  from public.workflows w join org on org.id = w.organization_id
  where w.company_id is null and w.status = 'active'
  union all
  select '07 workflow runs in flight', r.id::text,
    jsonb_build_object('workflow_id',r.workflow_id,'status',r.status,'resume_at',r.resume_at,'created_at',r.created_at)
  from public.workflow_runs r join co on co.id = r.company_id
  where r.status in ('pending','running','waiting')
  union all
  select '08 workflow event jobs queued', j.id::text,
    jsonb_build_object('status',j.status,'available_at',j.available_at,'attempt_count',j.attempt_count)
  from public.workflow_event_jobs j join co on co.id = j.company_id
  where j.status in ('pending','running')
  union all
  select '09 workflow schedule ticks pending', t.id::text,
    jsonb_build_object('workflow_id',t.workflow_id,'scheduled_for',t.scheduled_for,'status',t.status)
  from public.workflow_schedule_ticks t join wf on wf.id = t.workflow_id
  where t.status in ('pending','running')
  union all
  select '10 inbound webhook jobs queued', j.id::text,
    jsonb_build_object('provider',j.provider,'status',j.status,'run_at',j.run_at,'attempts',j.attempts)
  from public.inbound_webhook_jobs j join co on co.id = j.company_id
  where j.status in ('pending','running')
  union all
  select '11 recurring series active', rj.id::text,
    jsonb_build_object('title',rj.title,'frequency',rj.frequency,'interval_count',rj.interval_count,'start_date',rj.start_date,
      'ends_on',rj.ends_on,'generated_through',rj.generated_through,'contact_id',rj.contact_id)
  from public.recurring_jobs rj join co on co.id = rj.company_id
  where rj.status = 'active'
  union all
  select '12 upcoming bookings', b.id::text,
    jsonb_build_object('title',b.title,'scheduled_for',b.scheduled_for,'status',b.status,'recurring_job_id',b.recurring_job_id,
      'source',b.source,'hold_expires_at',b.hold_expires_at,'deposit_paid_at',b.deposit_paid_at)
  from public.bookings b join co on co.id = b.company_id
  where b.status in ('pending','confirmed') and b.scheduled_for >= now()
  union all
  select '13 service plans active', p.id::text,
    jsonb_build_object('name',p.name,'billing',p.billing,'price_cents',p.price_cents,'visit_months',p.visit_months)
  from public.service_plans p join co on co.id = p.company_id
  where p.active
  union all
  select '14 service agreements live', a.id::text,
    jsonb_build_object('plan_name',a.plan_name,'status',a.status,'term_end',a.term_end,'recurring_job_id',a.recurring_job_id,
      'pending_invoice_id',a.pending_invoice_id,'contact_id',a.contact_id)
  from public.service_agreements a join co on co.id = a.company_id
  where a.status in ('pending_owner','pending_payment','active','renewal_due')
  union all
  select '15 open quotes (+follow-ups)', q.id::text,
    jsonb_build_object('quote_number',q.quote_number,'status',q.status,'sent_at',q.sent_at,'expires_at',q.expires_at,
      'expiry_reminder_sent_at',q.expiry_reminder_sent_at,'total_cents',q.total_cents,'deposit_cents',q.deposit_cents,
      'followup_nudges_sent',f.nudges_sent,'followup_last_nudge_at',f.last_nudge_at,'followup_stopped_at',f.stopped_at)
  from public.quotes q join co on co.id = q.company_id
  left join public.quote_follow_ups f on f.quote_id = q.id
  where q.status in ('draft','sent','viewed','approved')
  union all
  select '16 unpaid invoices (+collections)', i.id::text,
    jsonb_build_object('invoice_number',i.invoice_number,'status',i.status,'due_date',i.due_date,'balance_due_cents',i.balance_due_cents,
      'reminder_count',i.reminder_count,'last_reminder_at',i.last_reminder_at,'reminders_paused',i.reminders_paused,'import_hold',i.import_hold,
      'sms_count',ic.sms_count,'sms_hold_until',ic.hold_until,'final_notice_status',ic.final_notice_status)
  from public.invoices i join co on co.id = i.company_id
  left join public.invoice_collections ic on ic.invoice_id = i.id
  where i.status in ('sent','viewed','partially_paid') and i.balance_due_cents > 0
  union all
  select '17 invoice reminder texts queued', t.id::text,
    jsonb_build_object('invoice_id',t.invoice_id,'kind',t.kind,'status',t.status,'reminder_key',t.reminder_key)
  from public.invoice_reminder_texts t join co on co.id = t.company_id
  where t.status in ('queued','claimed')
  union all
  select '18 payment plans active', pp.id::text,
    jsonb_build_object('invoice_id',pp.invoice_id,'total_cents',pp.total_cents,'instalments',pp.instalments)
  from public.payment_plans pp join co on co.id = pp.company_id
  where pp.status = 'active'
  union all
  select '19 review requests pending', rr.id::text,
    jsonb_build_object('source',rr.source,'status',rr.status,'scheduled_for',rr.scheduled_for,'contact_id',rr.contact_id)
  from public.review_requests rr join co on co.id = rr.company_id
  where rr.status in ('scheduled','sending')
  union all
  select '20 voice_numbers active (calls/SMS route here)', v.id::text,
    jsonb_build_object('phone_e164',v.phone_e164,'provider',v.provider,'mode',v.mode,'provider_agent_id',v.provider_agent_id,
      'provider_number_sid',v.provider_number_sid,'brand_label',v.brand_label,'forwarding_verified_at',v.forwarding_verified_at)
  from public.voice_numbers v join co on co.id = v.company_id
  where v.active
  union all
  select '21 telnyx_numbers active (legacy, unread)', n.id::text,
    jsonb_build_object('phone_e164',n.phone_e164,'source_site',n.source_site,'brand_label',n.brand_label)
  from public.telnyx_numbers n join co on co.id = n.company_id
  where n.active
  union all
  select '22 retell voice profile active', p.id::text,
    jsonb_build_object('retell_outbound_agent_id',p.retell_outbound_agent_id,'from_number',p.from_number,'brand_label',p.brand_label)
  from public.company_voice_profiles p join co on co.id = p.company_id
  where p.active
  union all
  select '23 intake keys active', k.id::text,
    jsonb_build_object('key_prefix',k.key_prefix,'label',k.label,'last_used_at',k.last_used_at)
  from public.intake_keys k join co on co.id = k.company_id
  where k.active
  union all
  select '24 public form keys active (evpk_)', k.id::text,
    jsonb_build_object('public_key',k.public_key,'label',k.label,'form_type',k.form_type,'allowed_origins',k.allowed_origins,'last_used_at',k.last_used_at)
  from public.public_form_keys k join co on co.id = k.company_id
  where k.active
  union all
  select '25 inbound email inbox', e.id::text,
    jsonb_build_object('address',e.address,'forwarded_from',e.forwarded_from,'forwarding_confirmed_at',e.forwarding_confirmed_at,'last_received_at',e.last_received_at)
  from public.email_inboxes e join co on co.id = e.company_id
  union all
  select '26 owner approvals pending', a.id::text,
    jsonb_build_object('kind',a.kind,'summary',a.summary,'expires_at',a.expires_at,'created_at',a.created_at)
  from public.owner_approvals a join co on co.id = a.company_id
  where a.status = 'pending'
  union all
  select '27 SMS conversations AI is carrying', s.id::text,
    jsonb_build_object('contact_id',s.contact_id,'state',s.state,'last_inbound_at',s.last_inbound_at,'last_ai_reply_at',s.last_ai_reply_at)
  from public.sms_conversations s join co on co.id = s.company_id
  where s.state = 'ai'
  union all
  select '28 marketing campaigns not finished', m.id::text,
    jsonb_build_object('kind',m.kind,'status',m.status,'scheduled_for',m.scheduled_for,'audience_count',m.audience_count)
  from public.marketing_campaigns m join co on co.id = m.company_id
  where m.status in ('draft','awaiting_owner','approved','sending')
  union all
  select '29 google post drafts pending', g.id::text,
    jsonb_build_object('week_start',g.week_start,'status',g.status)
  from public.google_post_drafts g join co on co.id = g.company_id
  where g.status in ('draft','awaiting_owner','approved')
  union all
  select '30 customer-care check-ins scheduled', c.id::text,
    jsonb_build_object('status',c.status,'send_at',c.send_at,'booking_id',c.booking_id)
  from public.care_checkins c join co on co.id = c.company_id
  where c.status in ('scheduled','sending')
  union all
  select '31 estimate requests open', e.id::text,
    jsonb_build_object('status',e.status,'contact_id',e.contact_id,'created_at',e.created_at)
  from public.estimate_requests e join co on co.id = e.company_id
  where e.status in ('collecting','estimating','awaiting_owner')
  union all
  select '32 job postings open', j.id::text,
    jsonb_build_object('title',j.title,'status',j.status,'published_at',j.published_at)
  from public.job_postings j join co on co.id = j.company_id
  where j.status in ('awaiting_owner','open')
  union all
  select '33 compliance documents tracked', d.id::text,
    jsonb_build_object('kind',d.kind,'title',d.title,'status',d.status,'expires_on',d.expires_on)
  from public.compliance_documents d join co on co.id = d.company_id
  where d.status in ('pending','current','expiring','expired')
  union all
  select '34 number port requests open', p.id::text,
    jsonb_build_object('status',p.status,'numbers',p.numbers,'foc_date',p.foc_date)
  from public.number_port_requests p join co on co.id = p.company_id
  where p.status in ('collecting','ready','submitted','foc_scheduled')
  union all
  select '35 purchase orders open', po.id::text,
    jsonb_build_object('po_number',po.po_number,'status',po.status,'needed_by',po.needed_by,'supplier_name',po.supplier_name)
  from public.purchase_orders po join co on co.id = po.company_id
  where po.status in ('draft','approved','sent','confirmed','ready')
  union all
  select '36 rentals not returned', r.id::text,
    jsonb_build_object('item',r.item,'vendor',r.vendor,'due_back_at',r.due_back_at)
  from public.rentals r join co on co.id = r.company_id
  where r.returned_at is null
  union all
  select '37 accounting connection', ac.company_id::text,
    jsonb_build_object('provider',ac.provider,'status',ac.status,'remote_name',ac.remote_name,'last_sync_at',ac.last_sync_at)
  from public.accounting_connections ac join co on co.id = ac.company_id
  union all
  select '38 accounting sync jobs queued', j.id::text,
    jsonb_build_object('entity_type',j.entity_type,'status',j.status,'available_at',j.available_at)
  from public.accounting_sync_jobs j join co on co.id = j.company_id
  where j.status in ('pending','running')
  union all
  select '39 hosted website published', s.id::text,
    jsonb_build_object('slug',s.slug,'mode',s.mode,'status',s.status,'published_at',s.published_at)
  from public.company_sites s join co on co.id = s.company_id
  where s.status = 'published'
  union all
  select '40 activity last 30 days', co.id::text,
    jsonb_build_object(
      'raw_leads',(select count(*) from public.raw_leads x where x.company_id = co.id and x.created_at >= now() - interval '30 days'),
      'retell_calls',(select count(*) from public.retell_calls x where x.company_id = co.id and x.created_at >= now() - interval '30 days'),
      'missed_calls',(select count(*) from public.missed_calls x where x.company_id = co.id and x.created_at >= now() - interval '30 days'),
      'messages_outbound',(select count(*) from public.message_log x where x.company_id = co.id and x.direction = 'outbound' and x.created_at >= now() - interval '30 days'),
      'messages_inbound',(select count(*) from public.message_log x where x.company_id = co.id and x.direction = 'inbound' and x.created_at >= now() - interval '30 days'),
      'workflow_runs',(select count(*) from public.workflow_runs x where x.company_id = co.id and x.created_at >= now() - interval '30 days'))
  from co
) live
order by section, item;
