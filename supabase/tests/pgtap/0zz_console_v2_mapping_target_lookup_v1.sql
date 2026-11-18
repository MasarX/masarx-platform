BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'mapping_target'
       AND is_mutable IS FALSE
  ),
  'mapping_target lookup definition exists and is immutable'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.create'
       AND lv.is_default IS TRUE
       AND lv.status = 'active'
  ),
  'mapping_target includes default shipments.create target'
);

SELECT is(
  (
    SELECT lv.metadata->>'target_resource'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.create'
  ),
  'shipments',
  'shipments.create maps to shipments resource metadata'
);

SELECT is(
  (
    SELECT lv.metadata->>'target_action'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.create'
  ),
  'create',
  'shipments.create maps to create action metadata'
);

SELECT ok(
  (
    SELECT lv.metadata->'allowed_mapping_types' ? 'webhook_inbound'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.create'
  ),
  'shipments.create declares webhook_inbound as an allowed mapping type'
);

SELECT ok(
  (
    SELECT lv.metadata->'allowed_mapping_types' ? 'api_gateway_inbound'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.create'
  ),
  'shipments.create declares api_gateway_inbound as an allowed mapping type'
);

SELECT ok(
  (
    SELECT lv.metadata @> '{"canonical_intent":"shipment.create","workflow_template_name":"webhook_shipment_create_v1","api_gateway_workflow_template_name":"api_gateway_shipment_create_default_v1","workflow_templates_by_mapping_type":{"webhook_inbound":"webhook_shipment_create_v1","api_gateway_inbound":"api_gateway_shipment_create_default_v1"}}'::jsonb
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.create'
  ),
  'shipments.create keeps webhook workflow metadata and declares API Gateway workflow metadata separately'
);

SELECT ok(
  (
    SELECT lv.metadata->'required_output_paths' @> '[{"path":"recipient.name"},{"path":"recipient.phone"},{"path":"address.line1"},{"path":"address.city"},{"path":"address.country_code"}]'::jsonb
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.create'
  ),
  'shipments.create declares row-driven required output paths for remediation tests'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'webhook_response'
       AND lv.status = 'active'
  ),
  'mapping_target includes webhook_response target'
);

SELECT ok(
  (
    SELECT lv.metadata @> '{"target_resource":"shipments","target_action":"update","canonical_intent":"shipment.update","workflow_template_name":"api_gateway_shipment_update_default_v1"}'::jsonb
       AND lv.metadata->'allowed_mapping_types' ? 'api_gateway_inbound'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.update'
  ),
  'mapping_target includes API Gateway shipment update target metadata'
);

SELECT ok(
  (
    SELECT lv.metadata @> '{"target_resource":"shipments","target_action":"delete","canonical_intent":"shipment.delete","workflow_template_name":"api_gateway_shipment_cancel_default_v1"}'::jsonb
       AND lv.metadata->'allowed_mapping_types' ? 'api_gateway_inbound'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.delete'
  ),
  'mapping_target includes API Gateway shipment delete target metadata'
);

SELECT ok(
  (
    SELECT lv.metadata @> '{"canonical_intent":"shipment.delete","workflow_template_name":"shipment_delete_v1","api_gateway_workflow_template_name":"api_gateway_shipment_cancel_default_v1","workflow_templates_by_mapping_type":{"webhook_inbound":"shipment_delete_v1","api_gateway_inbound":"api_gateway_shipment_cancel_default_v1"}}'::jsonb
       AND lv.metadata->'allowed_mapping_types' ? 'api_gateway_inbound'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.cancel'
  ),
  'mapping_target keeps cancel webhook workflow metadata while declaring API Gateway workflow metadata'
);

SELECT ok(
  (
    SELECT lv.metadata @> '{"canonical_intent":"shipment.reschedule","workflow_template_name":"shipment_reschedule_v1"}'::jsonb
       AND lv.metadata->'allowed_mapping_types' ? 'api_gateway_inbound'
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.reschedule'
  ),
  'mapping_target keeps reschedule API Gateway-bindable and workflow-backed'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'domain_events'
       AND lv.status = 'active'
  ),
  'mapping_target includes domain_events target'
);

SELECT * FROM finish();

ROLLBACK;
