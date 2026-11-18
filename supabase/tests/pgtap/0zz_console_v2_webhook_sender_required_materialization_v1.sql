-- pgTAP: shipment-create webhooks must not leave inbox rows in_progress
-- when source context is missing the sender/client binding required for
-- materialization.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7101'::uuid,
  'Console V2 Webhook Missing Sender Org',
  'console-v2-webhook-missing-sender-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7102'::uuid,
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7101'::uuid,
  'Console V2 Webhook Missing Sender Client',
  'console-v2-webhook-missing-sender-client',
  'active'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    status = EXCLUDED.status;

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version
)
VALUES (
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7103'::uuid,
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7101'::uuid,
  'webhook_inbound',
  'console-v2-webhook-missing-sender-map',
  '{"target":"shipments.create"}'::jsonb,
  1
)
ON CONFLICT (id) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    updated_at = now();

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  auth_token_hash,
  mapping_config_id,
  sender_id,
  enabled
)
VALUES (
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7104'::uuid,
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7101'::uuid,
  'console-v2-webhook-missing-sender-source',
  'Console V2 Webhook Missing Sender Source',
  'generic',
  NULL,
  extensions.crypt('console-v2-webhook-missing-sender-token', extensions.gen_salt('bf')),
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7103'::uuid,
  NULL,
  TRUE
)
ON CONFLICT (id) DO UPDATE
SET sender_id = NULL,
    enabled = TRUE,
    mapping_config_id = EXCLUDED.mapping_config_id,
    auth_token_hash = EXCLUDED.auth_token_hash,
    updated_at = now();

SELECT public.upsert_webhook_ingest_policy(
  'source',
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7104'::uuid,
  jsonb_build_object(
    'version', 1,
    'ack', jsonb_build_object(
      'mode', 'accepted_async',
      'status_code', 202,
      'default_headers', jsonb_build_object('content-type', 'application/json')
    ),
    'workflow', jsonb_build_object(
      'template_id', public.resolve_active_workflow_template_ref_v1('async_provider_dispatch_v1'),
      'intent', 'shipment.create',
      'templates_by_intent', jsonb_build_object(
        'shipment.create',
        jsonb_build_object('template_id', public.resolve_active_workflow_template_ref_v1('async_provider_dispatch_v1')::text)
      )
    ),
    'validation', jsonb_build_object(
      'idempotency', jsonb_build_object('header', 'Idempotency-Key', 'body_path', 'event.id')
    )
  )
);

CREATE TEMP TABLE _webhook_result AS
SELECT public.workflow_intake_webhook_core_v1(
  'console-v2-webhook-missing-sender-token',
  jsonb_build_object(
    'idempotency-key', 'console-v2-webhook-missing-sender-idem',
    'x-correlation-id', 'console-v2-webhook-missing-sender-idem'
  ),
  jsonb_build_object(
    'event', jsonb_build_object(
      'id', 'console-v2-webhook-missing-sender-idem',
      'type', 'shipment.created'
    ),
    'shipment', jsonb_build_object(
      'external_id', 'WEBHOOK-MISSING-SENDER-1',
      'reference_number', 'WEBHOOK-MISSING-SENDER-REF-1',
      'service_type', 'standard',
      'service_level', 'next_day',
      'cod_amount', 88.50,
      'currency', 'SAR'
    ),
    'recipient', jsonb_build_object(
      'external_id', 'REC-WEBHOOK-MISSING-SENDER-1',
      'name', 'Webhook Missing Sender Recipient',
      'phone', '+12025550184',
      'email', 'webhook.missing.sender@example.test'
    ),
    'address', jsonb_build_object(
      'line1', 'King Fahd Road',
      'district', 'Al Olaya',
      'city', 'Riyadh',
      'country_code', 'SA'
    )
  )::text,
  jsonb_build_object(
    'event', jsonb_build_object(
      'id', 'console-v2-webhook-missing-sender-idem',
      'type', 'shipment.created'
    ),
    'shipment', jsonb_build_object(
      'external_id', 'WEBHOOK-MISSING-SENDER-1',
      'reference_number', 'WEBHOOK-MISSING-SENDER-REF-1',
      'service_type', 'standard',
      'service_level', 'next_day',
      'cod_amount', 88.50,
      'currency', 'SAR'
    ),
    'recipient', jsonb_build_object(
      'external_id', 'REC-WEBHOOK-MISSING-SENDER-1',
      'name', 'Webhook Missing Sender Recipient',
      'phone', '+12025550184',
      'email', 'webhook.missing.sender@example.test'
    ),
    'address', jsonb_build_object(
      'line1', 'King Fahd Road',
      'district', 'Al Olaya',
      'city', 'Riyadh',
      'country_code', 'SA'
    )
  )
) AS result;

SELECT is(
  (SELECT result->>'status' FROM _webhook_result LIMIT 1),
  '400',
  'receiver rejects shipment-create intake when source has no sender/client binding'
);

SELECT ok(
  (
    SELECT result#>>'{body,error}' LIKE '%sender/client%'
      FROM _webhook_result
     LIMIT 1
  ),
  'receiver response explains that shipment sender/client binding is required'
);

SELECT is(
  (SELECT result->>'response_reason' FROM _webhook_result LIMIT 1),
  'webhook_source_missing_sender_client',
  'receiver emits a machine-readable missing sender/client reason'
);

SELECT is(
  (
    SELECT count(*)::text
      FROM public.webhook_inbox wi
     WHERE wi.idempotency_key = 'console-v2-webhook-missing-sender-idem'
       AND wi.webhook_source_id = 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7104'::uuid
  ),
  '0',
  'rejected missing-sender intake does not create a webhook inbox row'
);

SELECT ok(
  NOT COALESCE((
    SELECT (public.ensure_webhook_source_plugin_binding_v1('b44f71d8-2b89-4f29-9ef6-aedc3b9f7104'::uuid)->>'ok')::boolean
  ), TRUE),
  'source plugin binding repair fails closed without sender binding'
);

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
  organization_id
)
VALUES (
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7105'::uuid,
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7104'::uuid,
  'generic',
  'shipment.created',
  jsonb_build_object(
    'shipment', jsonb_build_object(
      'external_id', 'WEBHOOK-MISSING-SENDER-LEGACY-1',
      'reference_number', 'WEBHOOK-MISSING-SENDER-LEGACY-REF-1',
      'service_type', 'standard',
      'service_level', 'next_day'
    ),
    'recipient', jsonb_build_object(
      'external_id', 'REC-WEBHOOK-MISSING-SENDER-LEGACY-1',
      'name', 'Webhook Missing Sender Legacy Recipient',
      'phone', '+12025550185',
      'email', 'webhook.missing.sender.legacy@example.test'
    ),
    'address', jsonb_build_object(
      'line1', 'King Fahd Road',
      'district', 'Al Olaya',
      'city', 'Riyadh',
      'country_code', 'SA'
    )
  ),
  jsonb_build_object(
    'shipment', jsonb_build_object(
      'external_id', 'WEBHOOK-MISSING-SENDER-LEGACY-1',
      'reference_number', 'WEBHOOK-MISSING-SENDER-LEGACY-REF-1',
      'service_type', 'standard',
      'service_level', 'next_day'
    ),
    'recipient', jsonb_build_object(
      'external_id', 'REC-WEBHOOK-MISSING-SENDER-LEGACY-1',
      'name', 'Webhook Missing Sender Legacy Recipient',
      'phone', '+12025550185',
      'email', 'webhook.missing.sender.legacy@example.test'
    ),
    'address', jsonb_build_object(
      'line1', 'King Fahd Road',
      'district', 'Al Olaya',
      'city', 'Riyadh',
      'country_code', 'SA'
    )
  ),
  jsonb_build_object(
    'idempotency-key', 'console-v2-webhook-missing-sender-legacy-idem',
    'x-correlation-id', 'console-v2-webhook-missing-sender-legacy-idem'
  ),
  'in_progress',
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7106'::uuid,
  'console-v2-webhook-missing-sender-legacy-idem',
  'b44f71d8-2b89-4f29-9ef6-aedc3b9f7101'::uuid
);

CREATE TEMP TABLE _legacy_workflow AS
SELECT public.start_workflow_run(
  public.resolve_active_workflow_template_ref_v1('async_provider_dispatch_v1'),
  jsonb_build_object(
    'webhook_id', 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7105',
    'correlation_id', 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7106',
    'organization_id', 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7101',
    'canonical_intent', 'shipment.create',
    'mapping_config_id', 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7103',
    'planned_shipment_id', 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7107',
    'planned_tracking_number', 'MSENDER1',
    'payload', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', 'WEBHOOK-MISSING-SENDER-LEGACY-1',
        'reference_number', 'WEBHOOK-MISSING-SENDER-LEGACY-REF-1',
        'service_type', 'standard',
        'service_level', 'next_day'
      ),
      'recipient', jsonb_build_object(
        'external_id', 'REC-WEBHOOK-MISSING-SENDER-LEGACY-1',
        'name', 'Webhook Missing Sender Legacy Recipient',
        'phone', '+12025550185',
        'email', 'webhook.missing.sender.legacy@example.test'
      ),
      'address', jsonb_build_object(
        'line1', 'King Fahd Road',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'country_code', 'SA'
      )
    ),
    'transformed_payload', jsonb_build_object(
      'shipment', jsonb_build_object(
        'external_id', 'WEBHOOK-MISSING-SENDER-LEGACY-1',
        'reference_number', 'WEBHOOK-MISSING-SENDER-LEGACY-REF-1',
        'service_type', 'standard',
        'service_level', 'next_day'
      ),
      'recipient', jsonb_build_object(
        'external_id', 'REC-WEBHOOK-MISSING-SENDER-LEGACY-1',
        'name', 'Webhook Missing Sender Legacy Recipient',
        'phone', '+12025550185',
        'email', 'webhook.missing.sender.legacy@example.test'
      ),
      'address', jsonb_build_object(
        'line1', 'King Fahd Road',
        'district', 'Al Olaya',
        'city', 'Riyadh',
        'country_code', 'SA'
      )
    ),
    'headers', jsonb_build_object(
      'idempotency-key', 'console-v2-webhook-missing-sender-legacy-idem',
      'x-correlation-id', 'console-v2-webhook-missing-sender-legacy-idem'
    ),
    'policy', jsonb_build_object(
      'workflow', jsonb_build_object('intent', 'shipment.create')
    ),
    'client_id', NULL,
    'sender_id', NULL
  )
) AS workflow_run_id;

SELECT public.progress_workflow_run(workflow_run_id, '{}'::jsonb) FROM _legacy_workflow;
SELECT public.progress_workflow_run(workflow_run_id, '{}'::jsonb) FROM _legacy_workflow;
SELECT public.progress_workflow_run(workflow_run_id, '{}'::jsonb) FROM _legacy_workflow;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

SELECT is(
  (
    SELECT wr.workflow_status
      FROM public.workflow_runs wr
      JOIN _legacy_workflow legacy ON legacy.workflow_run_id = wr.id
  ),
  'failed',
  'legacy accepted workflow fails instead of pretending shipment materialized'
);

SELECT is(
  (
    SELECT wi.processing_status
      FROM public.webhook_inbox wi
     WHERE wi.id = 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7105'::uuid
  ),
  'failed',
  'legacy accepted webhook inbox is marked failed when shipment context is missing'
);

SELECT ok(
  (
    SELECT wi.error_message LIKE '%missing required context%'
      FROM public.webhook_inbox wi
     WHERE wi.id = 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7105'::uuid
  ),
  'legacy accepted webhook inbox stores the actionable missing-context error'
);

SELECT is(
  (
    SELECT count(*)::text
      FROM public.shipments s
     WHERE s.tracking_number = 'MSENDER1'
        OR s.metadata->>'source_webhook_id' = 'b44f71d8-2b89-4f29-9ef6-aedc3b9f7105'
  ),
  '0',
  'missing sender/client context does not create a synthetic shipment'
);

SELECT * FROM finish();

ROLLBACK;
