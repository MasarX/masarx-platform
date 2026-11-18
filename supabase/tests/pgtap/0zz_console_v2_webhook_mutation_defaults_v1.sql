BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

SET search_path TO public, pgtap, extensions;

SELECT is(
  public.normalize_shipment_intent_v1(NULL, 'shipment.rescheduled'),
  'shipment.reschedule',
  'shipment.rescheduled resolves to canonical shipment.reschedule intent'
);

SELECT is(
  public.normalize_shipment_intent_v1(NULL, 'shipment.cancelled'),
  'shipment.delete',
  'shipment.cancelled compatibility spelling resolves to shipment.delete'
);

SELECT is(
  public.normalize_shipment_intent_v1('shipments.reschedule', NULL),
  'shipment.reschedule',
  'plural shipments.reschedule input normalizes to the singular canonical intent'
);

SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    jsonb_build_object(
      'event', jsonb_build_object('type', 'shipment.rescheduled'),
      'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-RESCHEDULE'),
      'delivery', jsonb_build_object('requested_date', '2026-05-18')
    ),
    NULL,
    'shipment.rescheduled'
  )->>'canonical_intent',
  'shipment.reschedule',
  'resolver preserves shipment.rescheduled as workflow-backed reschedule intent'
);

SELECT is(
  public.resolve_webhook_shipment_intent_v1(
    jsonb_build_object(
      'event', jsonb_build_object('type', 'shipment.canceled'),
      'shipment', jsonb_build_object('tracking_number', 'P0-WEBHOOK-CANCEL', 'cancel_reason', 'customer request')
    ),
    NULL,
    'shipment.canceled'
  )->>'canonical_intent',
  'shipment.delete',
  'resolver preserves shipment.canceled as workflow-backed delete/cancel intent'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.cancel'
       AND lv.status = 'active'
       AND lv.metadata->>'canonical_intent' = 'shipment.delete'
       AND lv.metadata->'allowed_mapping_types' ? 'webhook_inbound'
  ),
  'mapping_target exposes active webhook shipments.cancel target'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'mapping_target'
       AND lv.value = 'shipments.reschedule'
       AND lv.status = 'active'
       AND lv.metadata->>'canonical_intent' = 'shipment.reschedule'
       AND lv.metadata->'allowed_mapping_types' ? 'webhook_inbound'
  ),
  'mapping_target exposes active webhook shipments.reschedule target'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates
     WHERE name = 'shipment_delete_v1'
       AND status = 'active'
  ),
  'shipment_delete_v1 workflow template is active for webhook cancel defaults'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates
     WHERE name = 'shipment_reschedule_v1'
       AND status = 'active'
  ),
  'shipment_reschedule_v1 workflow template is active for webhook reschedule defaults'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'webhook_ingest_policy'
       AND cached_value#>>'{workflow,templates_by_intent,shipment.delete,template_name}' = 'shipment_delete_v1'
  ),
  'webhook_ingest_policy settings include default shipment.delete workflow template'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'webhook_ingest_policy'
       AND cached_value#>>'{workflow,templates_by_intent,shipment.reschedule,template_name}' = 'shipment_reschedule_v1'
  ),
  'webhook_ingest_policy settings include default shipment.reschedule workflow template'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'webhook_ingest_policy'
       AND value#>>'{workflow,templates_by_intent,shipment.delete,template_name}' = 'shipment_delete_v1'
  ),
  'webhook_ingest_policy settings_versions include default shipment.delete workflow template'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_versions
     WHERE category = 'webhook_ingest_policy'
       AND value#>>'{workflow,templates_by_intent,shipment.reschedule,template_name}' = 'shipment_reschedule_v1'
  ),
  'webhook_ingest_policy settings_versions include default shipment.reschedule workflow template'
);

SELECT * FROM finish();

ROLLBACK;
