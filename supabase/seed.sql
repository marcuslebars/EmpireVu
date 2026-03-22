do $$
declare
  thinker_organization_id uuid := '6cb7d59f-a6fb-4d1d-8d46-0992b8536c12';
  a1_marine_company_id uuid := '4d7f52d0-bef3-41d5-8eb3-cba7ea17d815';
  ranklocal_company_id uuid := '5529f26e-bf7f-4a8c-9a57-6d38ea6a14cf';
  marinemecca_company_id uuid := '8897a3a6-552c-4b62-a8d7-f97840b4120d';
  vitatee_company_id uuid := 'df0ef294-9a54-4b3e-bfd5-17bd5c9e5d65';
  sample_workflow_id uuid := 'fa55ceaf-0cb9-4d8f-8fa8-c35453dd7152';
  sample_event_id uuid := '7c7f241c-c1e8-4fc8-8c22-7336c79fec2f';
  sample_contact_id uuid := '17ab6b83-b610-41fc-9fa6-04f7f7d40144';
  sample_booking_id uuid := '14f9dcd7-d835-4424-84c8-f163ca4260df';
  sample_task_id uuid := 'cde8b9f7-9f84-4ead-bd75-c4e8a9d69192';
begin
  insert into public.organizations (id, name, slug, billing_email)
  values (thinker_organization_id, 'Thinker Holdings', 'thinker-holdings', 'ops@thinkerholdings.example')
  on conflict (id) do update
  set
    name = excluded.name,
    slug = excluded.slug,
    billing_email = excluded.billing_email,
    updated_at = timezone('utc', now());

  insert into public.companies (id, organization_id, name, slug, stage, website, notes)
  values
    (a1_marine_company_id, thinker_organization_id, 'A1 Marine Care', 'a1-marine-care', 'active', 'https://a1marinecare.example', 'Marine service operations'),
    (ranklocal_company_id, thinker_organization_id, 'RankLocal', 'ranklocal', 'active', 'https://ranklocal.example', 'SEO and local growth'),
    (marinemecca_company_id, thinker_organization_id, 'MarineMecca', 'marinemecca', 'prospect', 'https://marinemecca.example', 'Marketplace expansion'),
    (vitatee_company_id, thinker_organization_id, 'Vitatee', 'vitatee', 'active', 'https://vitatee.example', 'Wellness and ecommerce')
  on conflict (id) do update
  set
    name = excluded.name,
    slug = excluded.slug,
    stage = excluded.stage,
    website = excluded.website,
    notes = excluded.notes,
    updated_at = timezone('utc', now());

  insert into public.contacts (id, organization_id, company_id, first_name, last_name, email, phone, stage, notes, metadata)
  values (
    sample_contact_id,
    thinker_organization_id,
    a1_marine_company_id,
    'Lena',
    'Foster',
    'lena.foster@a1marinecare.example',
    '+1-555-0101',
    'qualified',
    'Primary operations contact for service scheduling.',
    jsonb_build_object('source', 'seed', 'industry', 'marine services')
  )
  on conflict (id) do update
  set
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    email = excluded.email,
    phone = excluded.phone,
    stage = excluded.stage,
    notes = excluded.notes,
    metadata = excluded.metadata,
    updated_at = timezone('utc', now());

  insert into public.bookings (id, organization_id, company_id, contact_id, title, description, scheduled_for, duration_minutes, status)
  values (
    sample_booking_id,
    thinker_organization_id,
    a1_marine_company_id,
    sample_contact_id,
    'Dockside planning call',
    'Seed booking for marine field operations planning.',
    timezone('utc', now()) + interval '7 days',
    45,
    'confirmed'
  )
  on conflict (id) do update
  set
    title = excluded.title,
    description = excluded.description,
    scheduled_for = excluded.scheduled_for,
    duration_minutes = excluded.duration_minutes,
    status = excluded.status,
    updated_at = timezone('utc', now());

  insert into public.workflows (id, organization_id, company_id, name, slug, description, status, trigger_event, definition)
  values (
    sample_workflow_id,
    thinker_organization_id,
    a1_marine_company_id,
    'Lead Intake',
    'lead-intake',
    'Prepared for event-driven lead qualification in a later milestone.',
    'active',
    'contact.created',
    '{"version":1,"nodes":[{"id":"capture","type":"capture-contact"},{"id":"assign","type":"assign-owner"}],"edges":[{"from":"capture","to":"assign"}]}'::jsonb
  )
  on conflict (id) do update
  set
    name = excluded.name,
    description = excluded.description,
    status = excluded.status,
    trigger_event = excluded.trigger_event,
    definition = excluded.definition,
    updated_at = timezone('utc', now());

  insert into public.activity_events (id, organization_id, company_id, actor_user_id, event_type, entity_type, entity_id, metadata_json, occurred_at)
  values (
    sample_event_id,
    thinker_organization_id,
    a1_marine_company_id,
    null,
    'contact.created',
    'contact',
    sample_contact_id,
    jsonb_build_object('source', 'seed', 'workflow_hint', 'lead-intake'),
    timezone('utc', now()) - interval '1 day'
  )
  on conflict (id) do update
  set
    event_type = excluded.event_type,
    actor_user_id = excluded.actor_user_id,
    entity_type = excluded.entity_type,
    entity_id = excluded.entity_id,
    metadata_json = excluded.metadata_json,
    occurred_at = excluded.occurred_at,
    updated_at = timezone('utc', now());

  insert into public.tasks (id, organization_id, company_id, contact_id, booking_id, workflow_id, title, description, status, priority, due_at)
  values (
    sample_task_id,
    thinker_organization_id,
    a1_marine_company_id,
    sample_contact_id,
    sample_booking_id,
    sample_workflow_id,
    'Confirm pre-visit checklist',
    'Seed task linked to contact, booking, and workflow for downstream automation.',
    'todo',
    'high',
    timezone('utc', now()) + interval '3 days'
  )
  on conflict (id) do update
  set
    title = excluded.title,
    description = excluded.description,
    status = excluded.status,
    priority = excluded.priority,
    due_at = excluded.due_at,
    updated_at = timezone('utc', now());

  insert into public.comments (organization_id, company_id, entity_type, entity_id, body)
  values (
    thinker_organization_id,
    a1_marine_company_id,
    'task',
    sample_task_id,
    'Seed comment to validate threaded collaboration data.'
  )
  on conflict do nothing;
end;
$$;