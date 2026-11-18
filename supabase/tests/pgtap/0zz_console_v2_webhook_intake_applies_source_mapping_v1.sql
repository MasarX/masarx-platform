-- pgTAP: the live webhook receiver must apply the source mapping before
-- workflow execution, not only expose the mapping to Console test tooling.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT ok(
  position(
    'public.apply_mapping_config(v_payload_for_db, v_source.mapping_config_id)'
    IN pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
  ) > 0,
  'workflow_intake_webhook_core_v1 applies source mapping_config_id to transformed_payload'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.webhook_sources ws
      JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
     WHERE COALESCE(ws.enabled, TRUE) IS TRUE
       AND mc.mapping_type = 'webhook_inbound'
       AND mc.mapping_config#>>'{metadata,payload_shape}' = 'external_shipment_envelope_v1'
  ),
  'live webhook source mapping is discovered from row-driven payload-shape policy'
);

WITH source_mapping AS (
  SELECT ws.mapping_config_id
    FROM public.webhook_sources ws
    JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
   WHERE COALESCE(ws.enabled, TRUE) IS TRUE
     AND mc.mapping_type = 'webhook_inbound'
     AND mc.mapping_config#>>'{metadata,payload_shape}' = 'external_shipment_envelope_v1'
   ORDER BY ws.created_at DESC, ws.id
   LIMIT 1
),
mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'event', jsonb_build_object('id', 'external-webhook-live-path-pgtap', 'type', 'shipment.created'),
      'shipment', jsonb_build_object(
        'reference', 'FT-WH-LIVE-PATH-1001',
        'service_type', 'delivery',
        'cod_amount', 143.25,
        'cod_currency', 'SAR',
        'recipient', jsonb_build_object(
          'external_id', 'REC-WH-LIVE-PATH-1001',
          'name', 'Noura Live Path PGTAP',
          'phone', '+12025550123'
        ),
        'destination', jsonb_build_object(
          'line1', 'King Fahd Road',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'country', 'SA'
        )
      )
    ),
    (SELECT mapping_config_id FROM source_mapping)
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{recipient,name}' FROM mapped),
  'Noura Live Path PGTAP',
  'source mapping used by live webhook source extracts nested recipient for workflow payload'
);

WITH source_mapping AS (
  SELECT ws.mapping_config_id
    FROM public.webhook_sources ws
    JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
   WHERE COALESCE(ws.enabled, TRUE) IS TRUE
     AND mc.mapping_type = 'webhook_inbound'
     AND mc.mapping_config#>>'{metadata,payload_shape}' = 'external_shipment_envelope_v1'
   ORDER BY ws.created_at DESC, ws.id
   LIMIT 1
),
mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'shipment', jsonb_build_object(
        'reference', 'FT-WH-LIVE-PATH-1001',
        'recipient', jsonb_build_object('name', 'Noura Live Path PGTAP', 'phone', '+12025550123'),
        'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
      )
    ),
    (SELECT mapping_config_id FROM source_mapping)
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,line1}' FROM mapped),
  'King Fahd Road',
  'source mapping used by live webhook source extracts nested destination for workflow payload'
);

SELECT * FROM finish();
ROLLBACK;
