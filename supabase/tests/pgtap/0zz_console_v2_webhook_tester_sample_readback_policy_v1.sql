-- pgTAP: Console V2 webhook tester uses backend lookup samples, tenant-scoped
-- plugin policy, and webhook inbox readback that can prove shipment creation.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(31);

SELECT has_function(
  'public',
  'repair_integration_plugin_webhook_policy_v1',
  ARRAY['uuid', 'uuid'],
  'webhook plugin policy repair helper exists'
);

SELECT has_column('public', 'v_webhook_inbox_directory', 'workflow_run_id', 'webhook directory exposes workflow_run_id');
SELECT has_column('public', 'v_webhook_inbox_directory', 'idempotency_key', 'webhook directory exposes idempotency_key');
SELECT has_column('public', 'v_webhook_inbox_directory', 'shipment_id', 'webhook directory exposes shipment_id');
SELECT has_column('public', 'v_webhook_inbox_directory', 'tracking_number', 'webhook directory exposes tracking_number');
SELECT has_column('public', 'v_webhook_inbox_directory', 'organization_id', 'webhook directory exposes organization_id for registry tenant scoping');

SELECT is(
  (
    SELECT lv.metadata#>>'{payload,event,type}'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ),
  'shipment.created',
  'default webhook sample payload is backend-backed and typed as shipment.created'
);

SELECT ok(
  (
    SELECT lv.metadata#>>'{payload,event,id}'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ) LIKE '%{{event_id}}%',
  'default webhook sample event id is tokenized for unique receiver runs'
);

SELECT isnt(
  (
    SELECT lv.metadata#>>'{payload,shipment,reference}'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ),
  'FT-REF-SAMPLE',
  'default webhook sample does not reuse a fixed shipment reference'
);

SELECT is(
  (
    SELECT lv.metadata->>'payload_shape'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ),
  'external_shipment_envelope_v1',
  'default webhook sample declares the external shipment envelope payload shape'
);

SELECT ok(
  (
    SELECT lv.metadata#>>'{payload,shipment,recipient,phone}'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ) LIKE '%{{recipient_phone}}%',
  'default webhook sample recipient phone is tokenized so receiver runs can create a new recipient'
);

SELECT ok(
  (
    SELECT lv.metadata#>>'{payload,shipment,recipient,email}'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ) LIKE '%{{recipient_email}}%',
  'default webhook sample recipient email is tokenized with the receiver run context'
);

SELECT is(
  (
    SELECT lv.metadata#>>'{payload,shipment,destination,country}'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ),
  'SA',
  'default webhook sample destination uses the nested shipment.destination country path'
);

SELECT ok(
  (
    SELECT lv.metadata#>'{payload,recipient}' IS NULL
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ),
  'default webhook sample does not expose stale top-level recipient fields'
);

SELECT ok(
  (
    SELECT lv.metadata#>'{payload,address}' IS NULL
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'webhook_sample_payload'
      AND lv.is_default = TRUE
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1
  ),
  'default webhook sample does not expose stale top-level address fields'
);

SELECT is(
  (
    SELECT public.normalize_shipment_intent_v1(d.mapping_config->>'target', NULL)
    FROM public.onboarding_integration_plugin_defaults d
    WHERE d.profile_key = 'default'
      AND d.scope_type = 'tenant'
      AND d.plugin_key = 'default-shipment-webhook-intake'
    LIMIT 1
  ),
  'shipment.create',
  'default shipment webhook onboarding binding resolves to shipment.create'
);

WITH registry AS (
  SELECT resource
  FROM jsonb_array_elements(
    COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)
  ) AS resource
  WHERE resource->>'key' = 'webhook_inbox_directory'
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM registry
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource->'filters', '[]'::jsonb)) AS filter
    WHERE filter->>'key' IN ('id', 'organization_id', 'workflow_run_id', 'idempotency_key', 'shipment_id')
    GROUP BY resource
    HAVING COUNT(DISTINCT filter->>'key') = 5
  ),
  'webhook inbox registry supports tenant, workflow, idempotency, and shipment readback filters'
);

WITH registry AS (
  SELECT resource
  FROM jsonb_array_elements(
    COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)
  ) AS resource
  WHERE resource->>'key' = 'webhook_inbox_directory'
)
SELECT is(
  (SELECT resource#>>'{scope_columns,tenant}' FROM registry LIMIT 1),
  'organization_id',
  'webhook inbox directory registry is tenant-scoped by organization_id'
);

WITH registry AS (
  SELECT resource
  FROM jsonb_array_elements(
    COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)
  ) AS resource
  WHERE resource->>'key' = 'webhook_inbox'
)
SELECT ok(
  NOT EXISTS (SELECT 1 FROM registry),
  'raw webhook inbox is absent from the browser read registry'
);

WITH registry AS (
  SELECT resource
  FROM jsonb_array_elements(
    COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)
  ) AS resource
  WHERE resource->>'key' = 'domain_events'
)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM registry
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource->'filters', '[]'::jsonb)) AS filter
    WHERE filter->>'key' = 'workflow_run_id'
      AND filter->>'column' = 'workflow_run_id'
      AND filter->>'op' = 'eq'
  ),
  'domain_events registry supports workflow_run_id filtering for scoped intake provenance reads'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'Console V2 Webhook Tester Readback Org',
  'console-v2-webhook-tester-readback-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281602'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'Console V2 Webhook Tester Client',
  'console-v2-webhook-tester-client',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  managed_by,
  managed_metadata
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281603'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'webhook_inbound',
  'console-v2-webhook-tester-readback-map',
  '{"target":"shipments.create"}'::jsonb,
  1,
  'integration_plugin',
  '{"plugin_id":"f0a5d3bb-1d92-4c6d-965b-725fb3281604","plugin_version_id":"f0a5d3bb-1d92-4c6d-965b-725fb3281605"}'::jsonb
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    updated_at = now();

INSERT INTO public.integration_plugins (
  id,
  organization_id,
  plugin_key,
  name,
  plugin_kind,
  status
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281604'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'console-v2-webhook-tester-readback',
  'Default Shipment Webhook Intake',
  'webhook',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET status = EXCLUDED.status,
    updated_at = now();

INSERT INTO public.integration_plugin_versions (
  id,
  plugin_id,
  organization_id,
  version_no,
  status,
  mapping_config,
  workflow_binding
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281605'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281604'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  1,
  'active',
  '{"target":"shipments.create"}'::jsonb,
  '{"template_name":"webhook_shipment_create_v1","intent":"shipment.create"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    workflow_binding = EXCLUDED.workflow_binding,
    status = EXCLUDED.status,
    updated_at = now();

UPDATE public.integration_plugins
SET active_version_id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281605'::uuid
WHERE id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281604'::uuid;

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  auth_token_hash,
  mapping_config_id,
  enabled,
  managed_by,
  managed_metadata
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281606'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'console-v2-webhook-tester-readback-source',
  'Console V2 Webhook Tester Readback Source',
  'generic',
  'ipt_console_v2_webhook_readback',
  'ipt_console_v2_webhook_readback_hash',
  'f0a5d3bb-1d92-4c6d-965b-725fb3281603'::uuid,
  TRUE,
  'integration_plugin',
  '{"plugin_id":"f0a5d3bb-1d92-4c6d-965b-725fb3281604","plugin_version_id":"f0a5d3bb-1d92-4c6d-965b-725fb3281605"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET mapping_config_id = EXCLUDED.mapping_config_id,
    managed_by = EXCLUDED.managed_by,
    managed_metadata = EXCLUDED.managed_metadata,
    updated_at = now();

INSERT INTO public.integration_plugin_bindings (
  plugin_version_id,
  organization_id,
  scope_type,
  scope_id,
  binding_type,
  runtime_resource_type,
  runtime_resource_id,
  enabled
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281605'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'tenant',
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'webhook_source',
  'webhook_sources',
  'f0a5d3bb-1d92-4c6d-965b-725fb3281606'::uuid,
  TRUE
);

SELECT public.repair_integration_plugin_webhook_policy_v1(
  'f0a5d3bb-1d92-4c6d-965b-725fb3281606'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281605'::uuid
);

SELECT is(
  (
    SELECT policy#>>'{workflow,intent}'
    FROM public.resolve_webhook_ingest_policy('f0a5d3bb-1d92-4c6d-965b-725fb3281606'::uuid)
    LIMIT 1
  ),
  'shipment.create',
  'repaired default webhook policy resolves shipment.create intent'
);

SELECT is(
  (
    SELECT wt.name
    FROM public.workflow_templates wt
    WHERE wt.id = (
      SELECT policy#>>'{workflow,template_id}'
      FROM public.resolve_webhook_ingest_policy('f0a5d3bb-1d92-4c6d-965b-725fb3281606'::uuid)
      LIMIT 1
    )::uuid
  ),
  'webhook_shipment_create_v1',
  'repaired default webhook policy resolves webhook shipment-create template'
);

SELECT set_config('app.workflow_run_id', 'f0a5d3bb-1d92-4c6d-965b-725fb3281607', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281607'::uuid,
  (SELECT id FROM public.workflow_templates WHERE name = 'webhook_intake_v1' LIMIT 1),
  1,
  'webhook',
  'completed',
  '{"workflow_run_id":"f0a5d3bb-1d92-4c6d-965b-725fb3281607"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET workflow_status = EXCLUDED.workflow_status,
    updated_at = now();

INSERT INTO public.webhook_inbox (
  id,
  webhook_source_id,
  provider_type,
  event_type,
  raw_payload,
  transformed_payload,
  headers,
  processing_status,
  correlation_id,
  idempotency_key,
  organization_id,
  workflow_run_id,
  ack_validation
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281608'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281606'::uuid,
  'generic',
  'shipment.created',
  '{"event":{"id":"evt-readback","type":"shipment.created"}}'::jsonb,
  '{"event":{"id":"evt-readback","type":"shipment.created"}}'::jsonb,
  '{"idempotency-key":"idem-readback"}'::jsonb,
  'succeeded',
  'f0a5d3bb-1d92-4c6d-965b-725fb3281609'::uuid,
  'idem-readback',
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281607'::uuid,
  '{"intent":{"canonical":"shipment.create"}}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET idempotency_key = EXCLUDED.idempotency_key,
    workflow_run_id = EXCLUDED.workflow_run_id,
    ack_validation = EXCLUDED.ack_validation,
    updated_at = now();

INSERT INTO public.shipments (
  id,
  organization_id,
  client_id,
  service_type,
  tracking_number,
  status,
  box_count,
  metadata
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281610'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281602'::uuid,
  'delivery',
  'MXWEBHOOKREADBACK01',
  'pending',
  1,
  '{"source_webhook_id":"f0a5d3bb-1d92-4c6d-965b-725fb3281608"}'::jsonb
)
ON CONFLICT (id, client_id) DO UPDATE
SET tracking_number = EXCLUDED.tracking_number,
    metadata = EXCLUDED.metadata,
    updated_at = now();

SELECT is(
  (
    SELECT idempotency_key
    FROM public.v_webhook_inbox_directory
    WHERE id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281608'::uuid
  ),
  'idem-readback',
  'webhook directory returns idempotency readback'
);

SELECT is(
  (
    SELECT organization_id::text
    FROM public.v_webhook_inbox_directory
    WHERE id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281608'::uuid
  ),
  'f0a5d3bb-1d92-4c6d-965b-725fb3281601',
  'webhook directory returns organization_id for tenant-scoped frontend reads'
);

SELECT is(
  (
    SELECT shipment_id::text
    FROM public.v_webhook_inbox_directory
    WHERE workflow_run_id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281607'::uuid
  ),
  'f0a5d3bb-1d92-4c6d-965b-725fb3281610',
  'webhook directory returns shipment readback by workflow_run_id'
);

SELECT is(
  (
    SELECT tracking_number
    FROM public.v_webhook_inbox_directory
    WHERE idempotency_key = 'idem-readback'
  ),
  'MXWEBHOOKREADBACK01',
  'webhook directory returns tracking number by idempotency readback'
);

UPDATE public.workflow_runs
SET context = jsonb_build_object(
  'webhook_id', 'f0a5d3bb-1d92-4c6d-965b-725fb3281608',
  'organization_id', 'f0a5d3bb-1d92-4c6d-965b-725fb3281601',
  'correlation_id', 'f0a5d3bb-1d92-4c6d-965b-725fb3281609',
  'headers', jsonb_build_object('idempotency-key', 'idem-readback'),
  'http_response', jsonb_build_object(
    'status', 202,
    'mode', 'accepted_async',
    'outcome', 'response_sent',
    'headers', jsonb_build_object('content-type', 'application/json'),
    'body', jsonb_build_object('status', 'accepted_async')
  )
)
WHERE id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281607'::uuid;

INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  operation_name,
  handler_key,
  step_status,
  max_retries
)
VALUES (
  'f0a5d3bb-1d92-4c6d-965b-725fb3281611'::uuid,
  'f0a5d3bb-1d92-4c6d-965b-725fb3281607'::uuid,
  '77770000-0000-0000-0000-000000770012'::uuid,
  2,
  'persist_http_response',
  'persist_http_response',
  'in_progress',
  3
)
ON CONFLICT (id) DO UPDATE
SET step_status = EXCLUDED.step_status,
    updated_at = now();

SELECT is(
  (
    WITH response AS (
      SELECT (workflow_handlers.persist_http_response_v1(wrs, wr, '{}'::jsonb)).status AS status
      FROM public.workflow_run_steps wrs
      JOIN public.workflow_runs wr ON wr.id = wrs.workflow_run_id
      WHERE wrs.id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281611'::uuid
    )
    SELECT status FROM response
  ),
  'completed',
  'persist_http_response_v1 completes with idempotency supplied only by the existing inbox/header'
);

SELECT is(
  (
    SELECT idempotency_key
    FROM public.webhook_inbox
    WHERE id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281608'::uuid
  ),
  'idem-readback',
  'persist_http_response_v1 preserves webhook inbox idempotency readback'
);

SELECT is(
  (
    SELECT ack_validation#>>'{intent,canonical}'
    FROM public.webhook_inbox
    WHERE id = 'f0a5d3bb-1d92-4c6d-965b-725fb3281608'::uuid
  ),
  'shipment.create',
  'persist_http_response_v1 preserves existing webhook acknowledgement validation'
);

SELECT ok(
  position(
    'v_entry_template_id := ''77770000-0000-0000-0000-000000770001''::UUID'
    IN pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
  ) = 0,
  'workflow_intake_webhook_core_v1 has no hardcoded entry template fallback'
);

UPDATE public.settings_versions
   SET value = value - 'entry_template_id',
       updated_at = now()
 WHERE category = 'webhook_intake';

UPDATE public.settings
   SET cached_value = cached_value - 'entry_template_id',
       last_updated = now()
 WHERE category = 'webhook_intake';

SELECT is(
  (
    public.workflow_intake_webhook_core_v1(
      'ipt_console_v2_webhook_readback',
      '{"idempotency-key":"missing-template-proof"}'::jsonb,
      '{"event":{"id":"evt-missing-template-proof","type":"shipment.created"}}',
      '{"event":{"id":"evt-missing-template-proof","type":"shipment.created"}}'::jsonb
    )->'body'->>'error'
  ),
  'Webhook intake entry template is not configured',
  'webhook intake fails closed when settings omit entry_template_id'
);

SELECT * FROM finish();

ROLLBACK;
