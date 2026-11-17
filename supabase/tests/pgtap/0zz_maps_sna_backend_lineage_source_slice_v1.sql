-- pgTAP: Maps/SNA backend-lineage support slice for manual and API/intake
-- shipment creation. This is backend/source coverage only, not readiness proof.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(26);

SET search_path TO public, pgtap, extensions, pg_temp;

SELECT has_function(
  'public',
  'address_coordinates_from_payload_v1',
  ARRAY['jsonb'],
  'canonical address coordinate payload normalizer is installed before shipment-create execution'
);

SELECT has_function(
  'public',
  'address_sa_short_code_from_payload_v1',
  ARRAY['jsonb'],
  'canonical Saudi short-address payload normalizer is installed before shipment-create execution'
);

SELECT is(
  public.address_sa_short_code_from_payload_v1(
    jsonb_build_object('shortNationalAddress', 'RNQA7082')
  ),
  'RNQA7082',
  'shipment-create short-address helper executes against a supported payload alias'
);

WITH point AS (
  SELECT public.address_coordinates_from_payload_v1(
    jsonb_build_object('lat', 24.7136, 'lng', 46.6753)
  )::geometry AS value
)
SELECT is(
  round(ST_Y((SELECT value FROM point))::numeric, 4),
  24.7136::numeric,
  'shipment-create coordinate helper executes and preserves latitude'
);

WITH point AS (
  SELECT public.address_coordinates_from_payload_v1(
    jsonb_build_object('lat', 24.7136, 'lng', 46.6753)
  )::geometry AS value
)
SELECT is(
  round(ST_X((SELECT value FROM point))::numeric, 4),
  46.6753::numeric,
  'shipment-create coordinate helper executes and preserves longitude'
);

SELECT ok(
  public.address_coordinates_from_payload_v1(NULL) IS NULL
    AND public.address_sa_short_code_from_payload_v1(NULL) IS NULL,
  'shipment-create address helpers preserve null payloads as null'
);

SELECT throws_ok(
  'SELECT public.address_coordinates_from_payload_v1(''{"lat":24.7136}''::jsonb)',
  '22023',
  'address coordinates require both latitude and longitude',
  'shipment-create coordinate helper rejects incomplete coordinate input'
);

SELECT ok(
  to_regprocedure('public.default_shipment_webhook_intake_mapping_config_v1()') IS NOT NULL,
  'default shipment webhook mapping profile function is installed'
);

SELECT ok(
  to_regprocedure('public.normalize_shipment_webhook_mapping_config_v1(text,jsonb)') IS NOT NULL,
  'shipment webhook mapping normalizer is installed'
);

WITH normalized AS (
  SELECT public.normalize_shipment_webhook_mapping_config_v1(
    'webhook_inbound',
    jsonb_build_object('target', 'shipments.create')
  ) AS mapping_config
)
SELECT ok(
  (SELECT mapping_config#>'{transforms,address,sa_short_code}' FROM normalized)
    @> '["shipment.destination.short_national_address","address.sa_short_code","shortCode"]'::jsonb,
  'minimal shipment-create mapping gains Saudi short national address fallback paths'
);

WITH normalized AS (
  SELECT public.normalize_shipment_webhook_mapping_config_v1(
    'webhook_inbound',
    jsonb_build_object('target', 'shipments.create')
  ) AS mapping_config
)
SELECT is(
  (SELECT mapping_config#>>'{metadata,short_address_profile}' FROM normalized),
  'sa_short_national_address_v1',
  'minimal shipment-create mapping declares the Saudi short address profile'
);

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  '00000000-0000-0000-0000-00000000ad51'::uuid,
  'webhook_inbound',
  'maps-sna-backend-lineage-minimal',
  jsonb_build_object('target', 'shipments.create'),
  1,
  'Maps/SNA pgTAP minimal shipment-create intake mapping'
)
ON CONFLICT (id) DO UPDATE
   SET mapping_type = EXCLUDED.mapping_type,
       mapping_key = EXCLUDED.mapping_key,
       mapping_config = EXCLUDED.mapping_config,
       mapping_version = EXCLUDED.mapping_version,
       notes = EXCLUDED.notes;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mapping_configs
     WHERE id = '00000000-0000-0000-0000-00000000ad51'::uuid
       AND mapping_config#>>'{metadata,payload_shape}' = 'external_shipment_envelope_v1'
       AND mapping_config#>>'{metadata,short_address_profile}' = 'sa_short_national_address_v1'
  ),
  'mapping_configs trigger normalizes product-created minimal shipment mappings'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mapping_configs
     WHERE id = '00000000-0000-0000-0000-00000000ad51'::uuid
       AND mapping_config#>'{transforms,shipment}' IS NOT NULL
       AND mapping_config#>'{transforms,recipient}' IS NOT NULL
       AND mapping_config#>'{transforms,address}' IS NOT NULL
  ),
  'normalized shipment-create mapping carries shipment, recipient, and address transforms'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'event', jsonb_build_object('id', 'maps-sna-product-created-pgtap', 'type', 'shipment.created'),
      'shipment', jsonb_build_object(
        'reference', 'MAPS-SNA-PRODUCT-PGTAP',
        'recipient', jsonb_build_object(
          'name', 'Maps SNA Product PGTAP',
          'phone', '+12025550123'
        ),
        'destination', jsonb_build_object(
          'line1', 'King Fahd Road',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'country', 'SA',
          'short_national_address', 'RNQA7082'
        )
      )
    ),
    '00000000-0000-0000-0000-00000000ad51'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,sa_short_code}' FROM mapped),
  'RNQA7082',
  'normalized shipment-create mapping maps nested shipment.destination.short_national_address to address.sa_short_code'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'shortCode', 'RNQA7082',
      'shipment', jsonb_build_object(
        'reference', 'MAPS-SNA-PRODUCT-PGTAP',
        'recipient', jsonb_build_object('name', 'Maps SNA Product PGTAP'),
        'destination', jsonb_build_object('line1', 'King Fahd Road', 'city', 'Riyadh', 'country', 'SA')
      )
    ),
    '00000000-0000-0000-0000-00000000ad51'::uuid
  ) AS payload
)
SELECT is(
  (SELECT payload#>>'{address,sa_short_code}' FROM mapped),
  'RNQA7082',
  'normalized shipment-create mapping maps top-level shortCode fallback to address.sa_short_code'
);

WITH mapped AS (
  SELECT public.apply_mapping_config(
    jsonb_build_object(
      'shipment', jsonb_build_object(
        'reference', 'MAPS-SNA-PRODUCT-PGTAP',
        'recipient', jsonb_build_object(
          'name', 'Maps SNA Product PGTAP',
          'phone', '+12025550123'
        ),
        'destination', jsonb_build_object(
          'line1', 'King Fahd Road',
          'district', 'Al Olaya',
          'city', 'Riyadh',
          'country', 'SA',
          'short_national_address', 'RNQA7082'
        )
      )
    ),
    '00000000-0000-0000-0000-00000000ad51'::uuid
  ) AS payload
)
SELECT ok(
  (SELECT payload FROM mapped) @> jsonb_build_object(
    'recipient', jsonb_build_object('name', 'Maps SNA Product PGTAP'),
    'address', jsonb_build_object(
      'line1', 'King Fahd Road',
      'city', 'Riyadh',
      'country_code', 'SA',
      'sa_short_code', 'RNQA7082'
    )
  ),
  'normalized shipment-create mapping preserves canonical recipient and address readback payload'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%v_address_sa_short_code%',
  'shipment_create handler extracts Saudi short national address from canonical address payload'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%sa_short_code,%',
  'shipment_create handler writes Saudi short national address into canonical addresses.sa_short_code'
);

SELECT is(
  (
    SELECT array_agg(wts.id ORDER BY wts.sequence_order)
      FROM public.workflow_templates wt
      JOIN public.workflow_template_steps wts ON wts.workflow_template_id = wt.id
     WHERE wt.name = 'webhook_shipment_create_v1'
       AND wt.status = 'active'
       AND wts.enabled IS TRUE
  ),
  ARRAY[
    '77770000-0000-0000-0000-000000770021'::uuid,
    '77770000-0000-0000-0000-000000770022'::uuid,
    '77770000-0000-0000-0000-000000770023'::uuid,
    '77770000-0000-0000-0000-000000770025'::uuid,
    '77770000-0000-0000-0000-000000770024'::uuid
  ],
  'webhook shipment-create workflow exposes exactly the five canonical enabled steps'
);

SELECT ok(
  public.workflow_template_supports_inbound_shipment_create_v1(
    (SELECT id FROM public.workflow_templates WHERE name = 'webhook_shipment_create_v1' AND status = 'active')
  ),
  'dedicated webhook shipment-create workflow satisfies the inbound materializer contract'
);

SELECT is(
  (
    SELECT array_agg(
      concat_ws(':', wts.sequence_order, wts.operation_name, COALESCE(wts.next_operation_name, ''))
      ORDER BY wts.sequence_order
    )
      FROM public.workflow_templates wt
      JOIN public.workflow_template_steps wts ON wts.workflow_template_id = wt.id
     WHERE wt.name = 'webhook_shipment_create_v1'
       AND wt.status = 'active'
       AND wts.enabled IS TRUE
  ),
  ARRAY[
    '0:context_extract_from_mapping:reserve_identifiers',
    '1:reserve_identifiers:create_shipment',
    '2:create_shipment:geocode_created_shipment',
    '3:geocode_created_shipment:record_workflow_completion',
    '4:record_workflow_completion:'
  ]::TEXT[],
  'webhook shipment-create workflow preserves the exact deterministic next-operation chain'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%destination_address_id%' AND
  pg_get_functiondef('workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%context_patch%',
  'shipment_create handler emits shipment/address context for the following geocode lineage step'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%geocoding_resolve_policy_for_run%'
    AND pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
      LIKE '%geocoding_get_plugin%',
  'manual geocode handler resolves short-address policy from workflow context'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%reverse_geocode_on_hit%'
    AND pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
      LIKE '%reverse_geocode%',
  'manual geocode handler carries policy-backed reverse geocode intent for short-code coordinate hits'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%sa_short_code%'
    AND pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
      LIKE '%provided_coordinates%',
  'manual geocode handler carries Saudi short national address and provided coordinates into nested geocoding context'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
     WHERE wt.name = 'webhook_shipment_create_v1'
       AND wt.metadata->>'shipment_create_geocode_lineage' = 'shipment_update_geocode_v1'
  ),
  'workflow template metadata records the shipment-create geocode lineage source'
);

SELECT * FROM finish();

ROLLBACK;
