-- pgTAP: Console V2 webhook intake directory exposes mapping evidence.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT has_column('public', 'v_webhook_inbox_directory', 'mapping_config_id', 'webhook directory exposes mapping_config_id');
SELECT has_column('public', 'v_webhook_inbox_directory', 'mapping_label', 'webhook directory exposes mapping_label');
SELECT has_column('public', 'v_webhook_inbox_directory', 'mapping_target', 'webhook directory exposes mapping_target');
SELECT has_column('public', 'v_webhook_inbox_directory', 'mapping_version', 'webhook directory exposes mapping_version');
SELECT has_column('public', 'v_webhook_inbox_directory', 'mapping_rules_count', 'webhook directory exposes mapping_rules_count');

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'f8b00000-0000-0000-0000-000000000101'::uuid,
  'Console V2 Webhook Mapping Evidence Org',
  'console-v2-webhook-mapping-evidence-org'
);

INSERT INTO public.mapping_configs (
  id,
  organization_id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version
)
VALUES (
  'f8b00000-0000-0000-0000-000000000102'::uuid,
  'f8b00000-0000-0000-0000-000000000101'::uuid,
  'webhook_inbound',
  'console-v2-mapping-evidence-profile',
  '{"target":"shipments.create","rules":[{"from":"shipment.reference_number","to":"client_reference_number"}]}'::jsonb,
  7
);

INSERT INTO public.webhook_sources (
  id,
  organization_id,
  source_identifier,
  name,
  provider_type,
  auth_token,
  mapping_config_id,
  enabled
)
VALUES (
  'f8b00000-0000-0000-0000-000000000103'::uuid,
  'f8b00000-0000-0000-0000-000000000101'::uuid,
  'console-v2-mapping-evidence-source',
  'Console V2 Mapping Evidence Source',
  'generic',
  'console-v2-mapping-evidence-token',
  'f8b00000-0000-0000-0000-000000000102'::uuid,
  TRUE
);

INSERT INTO public.webhook_inbox (
  id,
  organization_id,
  webhook_source_id,
  provider_type,
  external_id,
  event_type,
  processing_status,
  correlation_id,
  idempotency_key,
  raw_payload,
  transformed_payload,
  created_at
)
VALUES (
  'f8b00000-0000-0000-0000-000000000104'::uuid,
  'f8b00000-0000-0000-0000-000000000101'::uuid,
  'f8b00000-0000-0000-0000-000000000103'::uuid,
  'generic',
  'console-v2-mapping-evidence-event',
  'shipment.created',
  'succeeded',
  'f8b00000-0000-0000-0000-000000000105'::uuid,
  'console-v2-mapping-evidence-idempotency',
  '{"event":{"type":"shipment.created"}}'::jsonb,
  '{"shipment":{"reference_number":"MAPPING-EVIDENCE-1"}}'::jsonb,
  now()
);

SELECT is(
  (
    SELECT mapping_label
      FROM public.v_webhook_inbox_directory
     WHERE id = 'f8b00000-0000-0000-0000-000000000104'::uuid
  ),
  'console-v2-mapping-evidence-profile',
  'webhook directory resolves mapping label from source mapping config'
);

SELECT is(
  (
    SELECT mapping_target
      FROM public.v_webhook_inbox_directory
     WHERE id = 'f8b00000-0000-0000-0000-000000000104'::uuid
  ),
  'shipments.create',
  'webhook directory resolves mapping target'
);

SELECT is(
  (
    SELECT mapping_rules_count
      FROM public.v_webhook_inbox_directory
     WHERE id = 'f8b00000-0000-0000-0000-000000000104'::uuid
  ),
  1,
  'webhook directory derives mapping rules count'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
     WHERE s.category = 'ui_read_registry'
       AND resource->>'key' = 'webhook_inbox_directory'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(resource->'filters', '[]'::jsonb)) AS filter
          WHERE filter->>'key' = 'mapping_config_id'
            AND filter->>'column' = 'mapping_config_id'
       )
  ),
  'ui_read_registry webhook_inbox_directory can filter by mapping_config_id'
);

SELECT * FROM finish();

ROLLBACK;
