-- Client API mapping breadth target catalog.
--
-- Tenant/client API Gateway mappings must cover the full shipment mutation
-- family without frontend literals. This extends the canonical Mapping Studio
-- target lookup with explicit general update and delete targets while keeping
-- create, cancel, and reschedule API-Gateway-bindable.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605312230_client_api_mapping_update_delete_targets_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'mapping_target'
),
seed(value, label, description, sort_order, is_default, metadata) AS (
  VALUES
    (
      'shipments.create',
      'Shipment create',
      'Normalize inbound client payloads into canonical shipment creation.',
      10,
      TRUE,
      '{"tone":"info","target_resource":"shipments","target_action":"create","canonical_intent":"shipment.create","backend_operation":"create","workflow_template_name":"webhook_shipment_create_v1","api_gateway_workflow_template_name":"api_gateway_shipment_create_default_v1","workflow_templates_by_mapping_type":{"webhook_inbound":"webhook_shipment_create_v1","api_gateway_inbound":"api_gateway_shipment_create_default_v1"},"allowed_mapping_types":["api_gateway_inbound","webhook_inbound","tabular_import"],"required_output_paths":[{"path":"recipient.name","label":"Recipient name"},{"path":"recipient.phone","label":"Recipient phone"},{"path":"address.line1","label":"Address line 1"},{"path":"address.city","label":"Address city"},{"path":"address.country_code","label":"Address country"}]}'::jsonb
    ),
    (
      'shipments.update',
      'Shipment update',
      'Normalize inbound client payloads into the workflow-backed shipment update path.',
      31,
      FALSE,
      '{"tone":"warn","target_resource":"shipments","target_action":"update","canonical_intent":"shipment.update","backend_operation":"update","workflow_template_name":"api_gateway_shipment_update_default_v1","allowed_mapping_types":["api_gateway_inbound"]}'::jsonb
    ),
    (
      'shipments.delete',
      'Shipment delete',
      'Normalize inbound client delete payloads into the workflow-backed shipment delete path.',
      34,
      FALSE,
      '{"tone":"danger","target_resource":"shipments","target_action":"delete","canonical_intent":"shipment.delete","backend_operation":"delete","workflow_template_name":"api_gateway_shipment_cancel_default_v1","allowed_mapping_types":["api_gateway_inbound"]}'::jsonb
    ),
    (
      'shipments.cancel',
      'Shipment cancel',
      'Normalize provider or client cancellation payloads into the workflow-backed shipment cancel path.',
      35,
      FALSE,
      '{"tone":"danger","target_resource":"shipments","target_action":"cancel","canonical_intent":"shipment.delete","backend_operation":"cancel","workflow_template_name":"shipment_delete_v1","api_gateway_workflow_template_name":"api_gateway_shipment_cancel_default_v1","workflow_templates_by_mapping_type":{"webhook_inbound":"shipment_delete_v1","api_gateway_inbound":"api_gateway_shipment_cancel_default_v1"},"allowed_mapping_types":["api_gateway_inbound","webhook_inbound"]}'::jsonb
    ),
    (
      'shipments.reschedule',
      'Shipment reschedule',
      'Normalize provider or client reschedule payloads into the workflow-backed shipment reschedule path.',
      36,
      FALSE,
      '{"tone":"warn","target_resource":"shipments","target_action":"reschedule","canonical_intent":"shipment.reschedule","backend_operation":"reschedule","workflow_template_name":"shipment_reschedule_v1","allowed_mapping_types":["api_gateway_inbound","webhook_inbound"]}'::jsonb
    )
)
INSERT INTO public.lookup_values (
  id,
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  effective_from,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  definition.id,
  seed.value,
  seed.label,
  seed.description,
  seed.sort_order,
  seed.is_default,
  'active',
  seed.metadata,
  now(),
  now(),
  now()
FROM definition
CROSS JOIN seed
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = EXCLUDED.metadata,
    effective_from = COALESCE(public.lookup_values.effective_from, EXCLUDED.effective_from),
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605312230_client_api_mapping_update_delete_targets_v1'));

COMMIT;
