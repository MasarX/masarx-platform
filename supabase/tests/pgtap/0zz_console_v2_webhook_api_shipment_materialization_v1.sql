-- pgTAP: webhook/API shipment intake must materialize operator-relevant
-- shipment data, not only reserve a bare tracking number.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(22);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  'Console V2 Webhook API Materialization Org',
  'console-v2-webhook-api-materialization-org'
);

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  'f8a00000-0000-0000-0000-000000000102'::uuid,
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  'Console V2 Webhook API Materialization Client',
  'console-v2-webhook-api-materialization-client',
  'active'
);

INSERT INTO public.senders (id, client_id, name, status)
VALUES (
  'f8a00000-0000-0000-0000-000000000103'::uuid,
  'f8a00000-0000-0000-0000-000000000102'::uuid,
  'Console V2 Webhook API Materialization Sender',
  'active'
);

INSERT INTO public.canonical_cities (
  id,
  organization_id,
  name_canonical,
  province,
  country_code,
  source
)
VALUES (
  'f8a00000-0000-0000-0000-000000000120'::uuid,
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  'Riyadh',
  'Riyadh Province',
  'SA',
  'ops_verified'
)
ON CONFLICT (organization_id, name_canonical) WHERE source_city_id IS NULL
DO UPDATE SET
  province = EXCLUDED.province,
  country_code = EXCLUDED.country_code,
  source = EXCLUDED.source,
  is_active = TRUE,
  updated_at = now();

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
  'f8a00000-0000-0000-0000-000000000104'::uuid,
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  'webhook_inbound',
  'console-v2-webhook-api-materialization-map',
  '{"target":"shipments.create"}'::jsonb,
  1,
  'integration_plugin',
  '{"plugin_id":"f8a00000-0000-0000-0000-000000000105","plugin_version_id":"f8a00000-0000-0000-0000-000000000106"}'::jsonb
);

INSERT INTO public.integration_plugins (
  id,
  organization_id,
  plugin_key,
  name,
  plugin_kind,
  status
)
VALUES (
  'f8a00000-0000-0000-0000-000000000105'::uuid,
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  'console-v2-webhook-api-materialization',
  'Console V2 Webhook API Materialization',
  'webhook',
  'active'
);

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
  'f8a00000-0000-0000-0000-000000000106'::uuid,
  'f8a00000-0000-0000-0000-000000000105'::uuid,
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  1,
  'active',
  '{"target":"shipments.create"}'::jsonb,
  '{"template_name":"async_provider_dispatch_v1","intent":"shipment.create"}'::jsonb
);

UPDATE public.integration_plugins
SET active_version_id = 'f8a00000-0000-0000-0000-000000000106'::uuid
WHERE id = 'f8a00000-0000-0000-0000-000000000105'::uuid;

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
  enabled,
  managed_by,
  managed_metadata
)
VALUES (
  'f8a00000-0000-0000-0000-000000000107'::uuid,
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  'console-v2-webhook-api-materialization-source',
  'Console V2 Webhook API Materialization Source',
  'generic',
  NULL,
  extensions.crypt('console-v2-webhook-api-materialization-token', extensions.gen_salt('bf')),
  'f8a00000-0000-0000-0000-000000000104'::uuid,
  'f8a00000-0000-0000-0000-000000000103'::uuid,
  TRUE,
  'integration_plugin',
  '{"plugin_id":"f8a00000-0000-0000-0000-000000000105","plugin_version_id":"f8a00000-0000-0000-0000-000000000106"}'::jsonb
);

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
  'f8a00000-0000-0000-0000-000000000106'::uuid,
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  'tenant',
  'f8a00000-0000-0000-0000-000000000101'::uuid,
  'webhook_source',
  'webhook_sources',
  'f8a00000-0000-0000-0000-000000000107'::uuid,
  TRUE
);

SELECT ok(
  COALESCE((public.repair_integration_plugin_webhook_policy_v1(
    'f8a00000-0000-0000-0000-000000000107'::uuid,
    'f8a00000-0000-0000-0000-000000000106'::uuid
  )->>'ok')::boolean, false),
  'webhook source policy repair succeeds'
);

UPDATE public.webhook_sources
   SET sender_id = NULL
 WHERE id = 'f8a00000-0000-0000-0000-000000000107'::uuid;

CREATE TEMP TABLE _webhook_no_sender_result AS
SELECT public.workflow_intake_webhook_core_v1(
  'console-v2-webhook-api-materialization-token',
  jsonb_build_object(
    'idempotency-key', 'console-v2-webhook-api-materialization-nosender',
    'x-correlation-id', 'console-v2-webhook-api-materialization-nosender'
  ),
  jsonb_build_object(
    'event', jsonb_build_object(
      'id', 'console-v2-webhook-api-materialization-nosender',
      'type', 'shipment.created'
    ),
    'shipment', jsonb_build_object(
      'external_id', 'WEBHOOK-API-MATERIALIZE-NOSENDER',
      'reference_number', 'WEBHOOK-API-MATERIALIZE-NOSENDER-REF'
    )
  )::text,
  jsonb_build_object(
    'event', jsonb_build_object(
      'id', 'console-v2-webhook-api-materialization-nosender',
      'type', 'shipment.created'
    ),
    'shipment', jsonb_build_object(
      'external_id', 'WEBHOOK-API-MATERIALIZE-NOSENDER',
      'reference_number', 'WEBHOOK-API-MATERIALIZE-NOSENDER-REF'
    )
  )
) AS result;

UPDATE public.webhook_sources
   SET sender_id = 'f8a00000-0000-0000-0000-000000000103'::uuid
 WHERE id = 'f8a00000-0000-0000-0000-000000000107'::uuid;

SELECT is(
  (SELECT result->>'ack_outcome' FROM _webhook_no_sender_result LIMIT 1),
  'ack_failed',
  'shipment-create webhook intake fails closed when source lacks sender/client binding'
);
SELECT is(
  (SELECT result->>'response_reason' FROM _webhook_no_sender_result LIMIT 1),
  'webhook_source_missing_sender_client',
  'missing sender/client binding returns an operator-actionable reason'
);
SELECT ok(
  (SELECT result->>'workflow_run_id' FROM _webhook_no_sender_result LIMIT 1) IS NULL,
  'missing sender/client binding does not enqueue an unmaterializable workflow'
);

CREATE TEMP TABLE _webhook_result AS
SELECT public.workflow_intake_webhook_core_v1(
  'console-v2-webhook-api-materialization-token',
  jsonb_build_object(
    'idempotency-key', 'console-v2-webhook-api-materialization-idem',
    'x-correlation-id', 'console-v2-webhook-api-materialization-idem'
  ),
  jsonb_build_object(
    'event', jsonb_build_object(
      'id', 'console-v2-webhook-api-materialization-idem',
      'type', 'shipment.created'
    ),
    'shipment', jsonb_build_object(
      'external_id', 'WEBHOOK-API-MATERIALIZE-1',
      'reference_number', 'WEBHOOK-API-MATERIALIZE-REF-1',
      'service_type', 'standard',
      'service_level', 'next_day',
      'cod_amount', 188.50,
      'currency', 'SAR',
      'recipient', jsonb_build_object(
        'external_id', 'REC-WEBHOOK-API-MATERIALIZE-1',
        'name', 'Webhook API Materialized Recipient',
        'phone', '+12025550183',
        'email', 'webhook.api.materialized@example.com',
        'address', jsonb_build_object(
          'line1', 'King Fahd Road',
          'line2', 'Materialization proof',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'country_code', 'SA',
          'lat', 24.7136,
          'lng', 46.6753
        )
      )
    )
  )::text,
  jsonb_build_object(
    'event', jsonb_build_object(
      'id', 'console-v2-webhook-api-materialization-idem',
      'type', 'shipment.created'
    ),
    'shipment', jsonb_build_object(
      'external_id', 'WEBHOOK-API-MATERIALIZE-1',
      'reference_number', 'WEBHOOK-API-MATERIALIZE-REF-1',
      'service_type', 'standard',
      'service_level', 'next_day',
      'cod_amount', 188.50,
      'currency', 'SAR',
      'recipient', jsonb_build_object(
        'external_id', 'REC-WEBHOOK-API-MATERIALIZE-1',
        'name', 'Webhook API Materialized Recipient',
        'phone', '+12025550183',
        'email', 'webhook.api.materialized@example.com',
        'address', jsonb_build_object(
          'line1', 'King Fahd Road',
          'line2', 'Materialization proof',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'country_code', 'SA',
          'lat', 24.7136,
          'lng', 46.6753
        )
      )
    )
  )
) AS result;

CREATE TEMP TABLE _webhook_ids AS
SELECT
  (result->>'workflow_run_id')::uuid AS entry_run_id,
  (result->>'followup_workflow_run_id')::uuid AS followup_run_id,
  (result->>'webhook_id')::uuid AS webhook_id,
  result#>>'{body,resource,tracking_number}' AS tracking_number
FROM _webhook_result;

SELECT ok(
  (SELECT entry_run_id IS NOT NULL FROM _webhook_ids),
  'webhook intake returns entry workflow id'
);
SELECT ok(
  (SELECT followup_run_id IS NOT NULL FROM _webhook_ids),
  'webhook intake returns follow-up workflow id'
);

SELECT public.progress_workflow_run(entry_run_id, '{}'::jsonb) FROM _webhook_ids;
SELECT public.progress_workflow_run(entry_run_id, '{}'::jsonb) FROM _webhook_ids;
SELECT public.progress_workflow_run(entry_run_id, '{}'::jsonb) FROM _webhook_ids;
SELECT public.progress_workflow_run(followup_run_id, '{}'::jsonb) FROM _webhook_ids;
SELECT public.progress_workflow_run(followup_run_id, '{}'::jsonb) FROM _webhook_ids;
SELECT public.progress_workflow_run(followup_run_id, '{}'::jsonb) FROM _webhook_ids;

-- Workflow handlers may change session-level execution context; restore pgTAP lookup.
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE TEMP TABLE _created_shipment AS
SELECT
  s.id,
  s.tracking_number,
  s.client_reference_number,
  s.service_type,
  s.service_level,
  s.recipient_id,
  r.external_id AS recipient_external_id,
  r.name AS recipient_name,
  s.destination_address_id,
  a.city,
  a.district,
  a.normalized_line1,
  s.cod_amount,
  s.cod_currency,
  s.metadata
FROM public.shipments s
JOIN _webhook_ids ids ON ids.tracking_number = s.tracking_number
LEFT JOIN public.recipients r ON r.id = s.recipient_id
LEFT JOIN public.addresses a ON a.id = s.destination_address_id AND a.client_id = s.client_id;

SELECT ok(
  (SELECT count(*)::int FROM _created_shipment) = 1,
  'webhook follow-up materializes exactly one shipment'
);
SELECT ok(
  (SELECT client_reference_number FROM _created_shipment) = 'WEBHOOK-API-MATERIALIZE-REF-1',
  'shipment carries mapped client reference'
);
SELECT ok(
  (SELECT service_type FROM _created_shipment) = 'delivery',
  'provider service type is normalized to canonical delivery'
);
SELECT ok(
  (SELECT service_level FROM _created_shipment) = 'standard',
  'provider service type is retained as canonical service level when provider level is unsupported'
);
SELECT ok(
  (SELECT recipient_external_id FROM _created_shipment) = 'REC-WEBHOOK-API-MATERIALIZE-1',
  'recipient is created from nested provider payload'
);
SELECT ok(
  (SELECT recipient_name FROM _created_shipment) = 'Webhook API Materialized Recipient',
  'recipient display data is materialized from nested provider payload'
);
SELECT ok(
  (SELECT city FROM _created_shipment) = 'Riyadh',
  'destination address is created from provider payload'
);
SELECT ok(
  (
    SELECT a.province
      FROM public.addresses a
      JOIN _created_shipment s ON s.destination_address_id = a.id
  ) = 'Riyadh Province',
  'missing provider province is resolved from canonical city reference data'
);
SELECT ok(
  (SELECT cod_amount::numeric = 188.50::numeric FROM _created_shipment),
  'COD amount is copied to shipment'
);

SELECT ok(
  (
    SELECT count(*)::text
    FROM public.workflow_runs wr
    JOIN _webhook_ids ids
      ON wr.metadata->>'started_by_run_id' = ids.entry_run_id::text
      OR wr.context->>'started_by_run_id' = ids.entry_run_id::text
  ) = '1',
  'entry workflow does not enqueue a duplicate follow-up when one was pre-started'
);

SELECT ok(
  (
    SELECT wi.processing_status = 'succeeded' AND wi.processed_at IS NOT NULL
    FROM public.webhook_inbox wi
    JOIN _webhook_ids ids ON ids.webhook_id = wi.id
  ),
  'webhook inbox is marked succeeded after shipment materialization'
);

SELECT ok(
  (
    SELECT count(*)::int = 1
      FROM public.domain_events de
      JOIN _webhook_ids ids ON ids.entry_run_id = de.workflow_run_id
      JOIN _created_shipment s ON s.id = de.resource_id
     WHERE de.event_type = 'shipment.created'
       AND de.resource_type = 'shipment'
       AND de.payload->>'webhook_inbox_id' = ids.webhook_id::text
  ),
  'succeeded webhook shipment intake projects a shipment.created domain event on the entry workflow'
);

SELECT ok(
  (
    SELECT de.payload->>'shipment_workflow_run_id' = ids.followup_run_id::text
      FROM public.domain_events de
      JOIN _webhook_ids ids ON ids.entry_run_id = de.workflow_run_id
      JOIN _created_shipment s ON s.id = de.resource_id
     WHERE de.event_type = 'shipment.created'
       AND de.resource_type = 'shipment'
       AND de.payload->>'webhook_inbox_id' = ids.webhook_id::text
     LIMIT 1
  ),
  'shipment.created domain event keeps follow-up workflow lineage in payload'
);

SELECT public.project_webhook_shipment_created_domain_event_v1(ids.webhook_id, s.id)
FROM _webhook_ids ids
CROSS JOIN _created_shipment s;

SELECT ok(
  (
    SELECT count(*)::int = 1
      FROM public.domain_events de
      JOIN _webhook_ids ids ON ids.entry_run_id = de.workflow_run_id
      JOIN _created_shipment s ON s.id = de.resource_id
     WHERE de.event_type = 'shipment.created'
       AND de.resource_type = 'shipment'
       AND de.payload->>'webhook_inbox_id' = ids.webhook_id::text
  ),
  'shipment.created domain event projection is idempotent for duplicate readback'
);

INSERT INTO public.webhook_inbox (
  id,
  webhook_source_id,
  provider_type,
  external_id,
  event_type,
  raw_payload,
  transformed_payload,
  processing_status,
  correlation_id,
  workflow_run_id,
  idempotency_key
)
SELECT
  'f8a00000-0000-4000-8000-000000000920'::uuid,
  'f8a00000-0000-0000-0000-000000000107'::uuid,
  'generic',
  'console-v2-webhook-api-materialization-noncreate',
  'shipment.updated',
  jsonb_build_object('event', jsonb_build_object('id', 'console-v2-webhook-api-materialization-noncreate', 'type', 'shipment.updated')),
  jsonb_build_object('event', jsonb_build_object('id', 'console-v2-webhook-api-materialization-noncreate', 'type', 'shipment.updated')),
  'succeeded',
  gen_random_uuid(),
  ids.entry_run_id,
  'console-v2-webhook-api-materialization-noncreate'
FROM _webhook_ids ids;

SELECT public.project_webhook_shipment_created_domain_event_v1(
  'f8a00000-0000-4000-8000-000000000920'::uuid,
  s.id
)
FROM _created_shipment s;

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.domain_events de
     WHERE de.event_type = 'shipment.created'
       AND de.resource_type = 'shipment'
       AND de.payload->>'webhook_inbox_id' = 'f8a00000-0000-4000-8000-000000000920'
  ),
  'non-create webhook intents cannot project shipment.created domain events'
);

UPDATE public.shipments s
   SET metadata = jsonb_set(
     COALESCE(s.metadata, '{}'::jsonb) - 'source_webhook_id',
     '{provider_payload,webhook_id}',
     to_jsonb(ids.webhook_id::text),
     TRUE
   )
  FROM _webhook_ids ids
 WHERE s.tracking_number = ids.tracking_number;

SELECT ok(
  (
    SELECT v.shipment_id = s.id
      FROM public.v_webhook_inbox_directory v
      JOIN _created_shipment s ON s.id = v.shipment_id
      JOIN _webhook_ids ids ON ids.webhook_id = v.id
     LIMIT 1
  ),
  'webhook directory links shipment through provider-payload webhook lineage when first-create lineage is absent'
);

SELECT * FROM finish();
ROLLBACK;
