BEGIN;

SELECT plan(10);

SELECT has_view(
  'public',
  'v_webhook_inbox_directory',
  'webhook inbox directory view exists'
);

SELECT ok(
  pg_get_viewdef('public.v_webhook_inbox_directory'::regclass, true)
    LIKE '%COALESCE(wi.followup_workflow_status, wi.entry_workflow_status) = ''completed''%',
  'webhook directory terminal projection requires completed workflow readback'
);

SELECT ok(
  pg_get_viewdef('public.v_webhook_inbox_directory'::regclass, true)
    LIKE '%shp.id IS NOT NULL%',
  'webhook directory terminal projection requires canonical shipment readback'
);

SELECT ok(
  pg_get_viewdef('public.v_webhook_inbox_directory'::regclass, true)
    LIKE '%THEN ''succeeded''%',
  'webhook directory projects accepted-async shipment readback as succeeded only after backend proof'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'aaaaf140-0000-0000-0000-000000000001',
  'Webhook Directory Projection Org',
  'webhook-directory-projection-org'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES (
  'bbbaf140-0000-0000-0000-000000000001',
  'aaaaf140-0000-0000-0000-000000000001',
  'Webhook Directory Projection Client',
  'webhook-directory-projection-client'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config
) VALUES (
  'cccaf140-0000-0000-0000-000000000001',
  'aaaaf140-0000-0000-0000-000000000001',
  'webhook_inbound',
  'webhook-directory-projection',
  '{"target":"shipments.create","rules":[]}'::jsonb
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token_hash,
  mapping_config_id
) VALUES (
  'dddaf140-0000-0000-0000-000000000001',
  'aaaaf140-0000-0000-0000-000000000001',
  'webhook-directory-projection',
  'Webhook Directory Projection Source',
  'generic',
  'pgtap-webhook-directory-projection-hash',
  'cccaf140-0000-0000-0000-000000000001'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type,
  template_key
) VALUES (
  'eeeaf140-0000-0000-0000-000000000001',
  'Webhook Directory Projection Template',
  'Fixture template for webhook directory terminal readback projection',
  1,
  'active',
  'global',
  'webhook_directory_projection_v1'
) ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'fffaf140-0000-0000-0000-000000000001', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  completed_at,
  context
) VALUES (
  'fffaf140-0000-0000-0000-000000000001',
  'eeeaf140-0000-0000-0000-000000000001',
  1,
  'webhook',
  'completed',
  now(),
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'fffaf140-0000-0000-0000-000000000002', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  completed_at,
  context
) VALUES (
  'fffaf140-0000-0000-0000-000000000002',
  'eeeaf140-0000-0000-0000-000000000001',
  1,
  'webhook',
  'pending',
  NULL,
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.workflow_run_id', 'fffaf140-0000-0000-0000-000000000003', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  completed_at,
  context
) VALUES (
  'fffaf140-0000-0000-0000-000000000003',
  'eeeaf140-0000-0000-0000-000000000001',
  1,
  'webhook',
  'completed',
  now(),
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.webhook_inbox (
  id,
  organization_id,
  webhook_source_id,
  provider_type,
  external_id,
  event_type,
  raw_payload,
  processing_status,
  correlation_id,
  idempotency_key,
  workflow_run_id,
  created_at,
  ack_validation
) VALUES
  (
    '1111f140-0000-0000-0000-000000000001',
    'aaaaf140-0000-0000-0000-000000000001',
    'dddaf140-0000-0000-0000-000000000001',
    'generic',
    'pgtap-terminal-no-shipment',
    'shipment.created',
    '{"shipment":{"reference_number":"PGTAP-NO-SHIPMENT"}}'::jsonb,
    'in_progress',
    '9999f140-0000-0000-0000-000000000001',
    'pgtap-terminal-no-shipment',
    'fffaf140-0000-0000-0000-000000000001',
    now(),
    '{"intent":{"canonical":"shipments.create"}}'::jsonb
  ),
  (
    '1111f140-0000-0000-0000-000000000002',
    'aaaaf140-0000-0000-0000-000000000001',
    'dddaf140-0000-0000-0000-000000000001',
    'generic',
    'pgtap-pending-with-shipment',
    'shipment.created',
    '{"shipment":{"reference_number":"PGTAP-PENDING-SHIPMENT"}}'::jsonb,
    'in_progress',
    '9999f140-0000-0000-0000-000000000002',
    'pgtap-pending-with-shipment',
    'fffaf140-0000-0000-0000-000000000002',
    now(),
    '{"intent":{"canonical":"shipments.create"}}'::jsonb
  ),
  (
    '1111f140-0000-0000-0000-000000000003',
    'aaaaf140-0000-0000-0000-000000000001',
    'dddaf140-0000-0000-0000-000000000001',
    'generic',
    'pgtap-terminal-with-shipment',
    'shipment.created',
    '{"shipment":{"reference_number":"PGTAP-READY-SHIPMENT"}}'::jsonb,
    'in_progress',
    '9999f140-0000-0000-0000-000000000003',
    'pgtap-terminal-with-shipment',
    'fffaf140-0000-0000-0000-000000000003',
    now(),
    '{"intent":{"canonical":"shipments.create"}}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.shipments (
  id,
  organization_id,
  client_id,
  service_type,
  tracking_number,
  client_reference_number,
  status,
  metadata
) VALUES
  (
    '2222f140-0000-0000-0000-000000000002',
    'aaaaf140-0000-0000-0000-000000000001',
    'bbbaf140-0000-0000-0000-000000000001',
    'delivery',
    'PGTAP-PENDING-SHIPMENT',
    'PGTAP-PENDING-SHIPMENT',
    'created',
    '{"source_webhook_id":"1111f140-0000-0000-0000-000000000002"}'::jsonb
  ),
  (
    '2222f140-0000-0000-0000-000000000003',
    'aaaaf140-0000-0000-0000-000000000001',
    'bbbaf140-0000-0000-0000-000000000001',
    'delivery',
    'PGTAP-READY-SHIPMENT',
    'PGTAP-READY-SHIPMENT',
    'created',
    '{"source_webhook_id":"1111f140-0000-0000-0000-000000000003"}'::jsonb
  )
ON CONFLICT DO NOTHING;

SELECT is(
  (
    SELECT processing_status
      FROM public.v_webhook_inbox_directory
     WHERE id = '1111f140-0000-0000-0000-000000000001'
  ),
  'in_progress',
  'completed workflow without canonical shipment remains in_progress'
);

SELECT is(
  (
    SELECT is_terminal
      FROM public.v_webhook_inbox_directory
     WHERE id = '1111f140-0000-0000-0000-000000000001'
  ),
  false,
  'completed workflow without canonical shipment is not terminal'
);

SELECT is(
  (
    SELECT processing_status
      FROM public.v_webhook_inbox_directory
     WHERE id = '1111f140-0000-0000-0000-000000000002'
  ),
  'in_progress',
  'canonical shipment without completed entry workflow remains in_progress'
);

SELECT is(
  (
    SELECT is_terminal
      FROM public.v_webhook_inbox_directory
     WHERE id = '1111f140-0000-0000-0000-000000000002'
  ),
  false,
  'canonical shipment without completed entry workflow is not terminal'
);

SELECT is(
  (
    SELECT processing_status
      FROM public.v_webhook_inbox_directory
     WHERE id = '1111f140-0000-0000-0000-000000000003'
  ),
  'succeeded',
  'completed entry workflow plus canonical shipment projects succeeded'
);

SELECT is(
  (
    SELECT is_terminal
      FROM public.v_webhook_inbox_directory
     WHERE id = '1111f140-0000-0000-0000-000000000003'
  ),
  true,
  'completed entry workflow plus canonical shipment is terminal'
);

SELECT * FROM finish();
ROLLBACK;
