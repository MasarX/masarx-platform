-- Test Suite: API Gateway - Logestechs V2 postprocess extract (seed contract)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(27);

-- Ensure time partitions exist for decision_log/settings_resolution_log inserts (handler uses decision logging).
SELECT public.create_next_partitions();

-- ----------------------------------------------------------------------------
-- Seeded Logestechs V2 create shipment route: extract paths must support root `id` + `barcode`
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_route_packs
    WHERE name = 'logestechs_v2_mirror'
      AND enabled = TRUE
  ),
  'logestechs_v2_mirror pack exists and enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
      AND jsonb_typeof(r.policy #> '{postprocess,extract}') = 'object'
  ),
  'logestechs v2 create shipment route exists with postprocess.extract'
);

SELECT matches(
  (
    SELECT r.policy #>> '{postprocess,extract,provider_shipment_id_path}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '(^|\\|)id(\\||$)',
  'provider_shipment_id_path includes root id'
);

SELECT matches(
  (
    SELECT r.policy #>> '{postprocess,extract,provider_tracking_number_path}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '(^|\\|)barcode(\\||$)',
  'provider_tracking_number_path includes barcode'
);

SELECT is(
  (
    SELECT r.policy #>> '{postprocess,extract,service_type_path}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  'pkg.shipmentType',
  'postprocess.extract.service_type_path maps to pkg.shipmentType'
);

SELECT is(
  (
    SELECT r.policy #>> '{postprocess,extract,service_level_path}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  'pkg.serviceType',
  'postprocess.extract.service_level_path maps to pkg.serviceType'
);

SELECT matches(
  (
    SELECT r.policy #>> '{postprocess,extract,cod_amount_path}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '(^|\|)pkg\.toCollectFromReceiver(\||$)',
  'postprocess.extract.cod_amount_path prefers pkg.toCollectFromReceiver'
);

SELECT matches(
  (
    SELECT r.policy #>> '{postprocess,extract,promised_delivery_date_path}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '(^|\\|)expectedDeliveryDate(\\||$)',
  'postprocess.extract.promised_delivery_date_path includes expectedDeliveryDate'
);

SELECT is(
  (
    SELECT r.policy #>> '{headers,overrides,company-id}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '{{provider_account.company_id}}',
  'logestechs mirror policy enforces company-id via headers.overrides template' 
);

-- ----------------------------------------------------------------------------
-- Field mappings (SSOT): Logestechs V2 provider enums -> canonical values
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.field_mappings
    WHERE mapping_domain = 'service_type'
      AND provider_name = 'logestechs_3pl'
      AND direction IN ('inbound', 'both')
      AND provider_value = 'COD'
      AND canonical_value = 'delivery'
  ),
  'field_mappings service_type COD -> delivery (logestechs_3pl)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.field_mappings
    WHERE mapping_domain = 'service_type'
      AND provider_name = 'logestechs_3pl'
      AND direction IN ('inbound', 'both')
      AND provider_value = 'REGULAR'
      AND canonical_value = 'delivery'
  ),
  'field_mappings service_type REGULAR -> delivery (logestechs_3pl)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.field_mappings
    WHERE mapping_domain = 'service_type'
      AND provider_name = 'logestechs_3pl'
      AND direction IN ('inbound', 'both')
      AND provider_value = 'SWAP'
      AND canonical_value = 'swap'
  ),
  'field_mappings service_type SWAP -> swap (logestechs_3pl)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.field_mappings
    WHERE mapping_domain = 'service_type'
      AND provider_name = 'logestechs_3pl'
      AND direction IN ('inbound', 'both')
      AND provider_value = 'BRING'
      AND canonical_value = 'pickup'
  ),
  'field_mappings service_type BRING -> pickup (logestechs_3pl)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.field_mappings
    WHERE mapping_domain = 'service_level'
      AND provider_name = 'logestechs_3pl'
      AND direction IN ('inbound', 'both')
      AND provider_value = 'STANDARD'
      AND canonical_value = 'standard'
  ),
  'field_mappings service_level STANDARD -> standard (logestechs_3pl)'
);

-- ---------------------------------------------------------------------------- 
-- Handler sanity: with sample response {id, barcode}, postprocess must not skip
-- ---------------------------------------------------------------------------- 

DO $$
DECLARE
  v_provider_id UUID;
  v_route_id UUID;
BEGIN
  SELECT r.provider_id, r.id
    INTO v_provider_id, v_route_id
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
   WHERE p.name = 'logestechs_v2_mirror'
     AND upper(r.method) = 'POST'
     AND r.path_template = '/api/ship/request/by-email'
     AND r.scope_type = 'global'
     AND r.enabled = TRUE
   ORDER BY r.updated_at DESC
   LIMIT 1;

  IF v_provider_id IS NULL OR v_route_id IS NULL THEN
    RAISE EXCEPTION 'Seeded Logestechs route missing (provider_id/route_id)';
  END IF;

  -- Seed workflow context so outbound_calls insert passes engine guard.
  PERFORM set_config('app.workflow_run_id', '05000000-0000-0000-0000-000000000053', true);
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type
  )
  VALUES (
    '05000000-0000-0000-0000-000000000051',
    'pgtap_api_gateway_postprocess',
    'Fixture workflow for api gateway outbound guard context',
    1,
    'active',
    'global'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    handler_key,
    handler_version,
    enabled
  )
  VALUES (
    '05000000-0000-0000-0000-000000000052',
    '05000000-0000-0000-0000-000000000051',
    1,
    'workflow_control',
    'always',
    'workflow_control',
    'v1',
    TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context
  )
  VALUES (
    '05000000-0000-0000-0000-000000000053',
    '05000000-0000-0000-0000-000000000051',
    1,
    'test',
    'pending',
    '{}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_run_steps (
    id,
    workflow_run_id,
    workflow_template_step_id,
    sequence_order,
    step_status,
    operation_name,
    handler_key,
    handler_version,
    max_retries,
    enqueued_at,
    created_at,
    updated_at
  )
  VALUES (
    '05000000-0000-0000-0000-000000000054',
    '05000000-0000-0000-0000-000000000053',
    '05000000-0000-0000-0000-000000000052',
    1,
    'pending',
    'workflow_control',
    'workflow_control',
    'v1',
    1,
    now(),
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.workflow_run_step_id', '05000000-0000-0000-0000-000000000054', true);
  PERFORM set_config('platform.workflow_engine', '1', true);
  PERFORM set_config('platform.workflow_run_step_id', '05000000-0000-0000-0000-000000000054', true);

  -- Disable geocoding/label side-effects for deterministic handler test (extract behavior only).
  UPDATE public.api_routes
  SET policy = jsonb_set(
      jsonb_set(
        COALESCE(policy, '{}'::jsonb),
        '{postprocess,geocoding,enabled}',
        'false'::jsonb,
        TRUE
      ),
      '{postprocess,label,enabled}',
      'false'::jsonb,
      TRUE
    ),
    updated_at = now()
  WHERE id = v_route_id;

  -- Minimal scope + source for api_gateway_requests FK requirements.
  INSERT INTO organizations (id, name, slug)
  VALUES ('aaaa0000-0000-0000-0000-000000000050', 'API Gateway Org 050', 'pgtap-api-gateway-org-050')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO clients (id, organization_id, name, slug)
  VALUES (
    'bbbb0000-0000-0000-0000-000000000050',
    'aaaa0000-0000-0000-0000-000000000050',
    'API Gateway Client 050',
    'pgtap-api-gateway-client-050'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    'cccc0000-0000-0000-0000-000000000050',
    'bbbb0000-0000-0000-0000-000000000050',
    'API Gateway Sender 050',
    'API Gateway Sender 050',
    TRUE,
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    'dddd0000-0000-0000-0000-000000000050',
    'webhook_inbound',
    'pgtap-api-gateway-050::default',
    '{}'::jsonb,
    1,
    'pgTAP api gateway source mapping 050'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    rate_limit_per_hour,
    enabled,
    sender_id
  )
  VALUES (
    'eeee0000-0000-0000-0000-000000000050',
    'aaaa0000-0000-0000-0000-000000000050',
    'pgtap-api-gateway-source-050-postprocess',
    'API Gateway Source 050 Postprocess',
    'api_gateway',
    'token-api-gateway-050-postprocess',
    'dddd0000-0000-0000-0000-000000000050',
    1000,
    TRUE,
    'cccc0000-0000-0000-0000-000000000050'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.api_gateway_requests (
    id,
    organization_id,
    client_id,
    sender_id,
    source_id,
    correlation_id,
    route_id,
    method,
    path,
    query_string,
    request_headers,
    request_body,
    received_at,
    created_at,
    updated_at
  ) VALUES (
    '99990000-0000-0000-0000-000000000050',
    'aaaa0000-0000-0000-0000-000000000050',
    'bbbb0000-0000-0000-0000-000000000050',
    'cccc0000-0000-0000-0000-000000000050',
    'eeee0000-0000-0000-0000-000000000050',
    '77770000-0000-0000-0000-000000000050',
    v_route_id,
    'POST',
    '/api/ship/request/by-email',
    NULL,
    '{}'::jsonb,
    jsonb_build_object(
      'pkg', jsonb_build_object(
        'receiverName', 'QA Receiver 050',
        'receiverPhone', '+12025550123',
        'invoiceNumber', 'INV-050',
        'shipmentType', 'SWAP',
        'serviceType', 'STANDARD',
        'cod', '600',
        'toCollectFromReceiver', '123.45',
        'quantity', 2,
        'notes', 'Fragile 050'
      ),
      'originAddress', jsonb_build_object(
        'addressLine1', 'Test Origin 050',
        'city', 'Riyadh',
        'region', 'Riyadh',
        'country', 'SA',
        'cityId', 5,
        'villageId', 180,
        'regionId', 1,
        'nationalAddress', 'NAT-ORIGIN-050'
      ),
      'destinationAddress', jsonb_build_object(
        'addressLine1', 'Test Destination 050',
        'city', 'Riyadh',
        'region', 'Riyadh',
        'country', 'SA',
        'cityId', 1,
        'villageId', 38,
        'regionId', 1,
        'nationalAddress', 'NAT-DEST-050'
      )
    ),
    now(),
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO outbound_calls (
    id,
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    status,
    priority,
    retry_count,
    max_retries,
    scheduled_at,
    correlation_id,
    context,
    created_at,
    workflow_run_step_id
  ) VALUES (
    '88880000-0000-0000-0000-000000000050',
    'provider_api',
    'provider',
    v_provider_id,
    'POST',
    'https://example.test/api/ship/request/by-email',
    '{}'::jsonb,
    (SELECT request_body FROM public.api_gateway_requests WHERE id = '99990000-0000-0000-0000-000000000050'),
    'completed',
    100,
    0,
    1,
    now(),
    '77770000-0000-0000-0000-000000000050',
    jsonb_build_object('api_gateway_request_id', '99990000-0000-0000-0000-000000000050'),
    now(),
    '05000000-0000-0000-0000-000000000054'
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.api_gateway_requests
  SET outbound_call_id = '88880000-0000-0000-0000-000000000050',
      updated_at = now()
  WHERE id = '99990000-0000-0000-0000-000000000050';
END;
$$;

CREATE TEMP TABLE tmp_gateway_postprocess AS
SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
  (SELECT oc FROM public.outbound_calls oc WHERE oc.id = '88880000-0000-0000-0000-000000000050'),
  jsonb_build_object(
    'id', 12345650,
    'barcode', 'PGTAP-GW-050-BARCODE',
    'expectedDeliveryDate', '2020-10-16T11:19:47.131+0200'
  )
) AS result;

SELECT is(
  (SELECT result->>'handled' FROM tmp_gateway_postprocess),
  'true',
  'process_api_gateway_outbound_response_v1 handles when tracking is extractable'
);

SELECT matches(
  (SELECT result->'postprocess'->>'shipment_id' FROM tmp_gateway_postprocess),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text,
  'postprocess returns shipment_id'
);

SELECT is(
  (
    SELECT tracking_number
    FROM public.shipments
    WHERE id = (SELECT (result->'postprocess'->>'shipment_id')::uuid FROM tmp_gateway_postprocess)
  ),
  'PGTAP-GW-050-BARCODE',
  'postprocess inserts shipment with tracking_number=barcode'
);

SELECT is(
  (
    SELECT service_type
    FROM public.shipments
    WHERE id = (SELECT (result->'postprocess'->>'shipment_id')::uuid FROM tmp_gateway_postprocess)
  ),
  'swap',
  'postprocess maps pkg.shipmentType to service_type via field_mappings'
);

SELECT is(
  (
    SELECT service_level
    FROM public.shipments
    WHERE id = (SELECT (result->'postprocess'->>'shipment_id')::uuid FROM tmp_gateway_postprocess)
  ),
  'standard',
  'postprocess maps pkg.serviceType to service_level via field_mappings'
);

SELECT matches(
  (
    SELECT dl.decision_inputs->>'mapping_id'
    FROM public.decision_log dl
    WHERE dl.resource_type = 'api_gateway_request'
      AND dl.resource_id = '99990000-0000-0000-0000-000000000050'::uuid
      AND dl.decision_point = 'service_type_mapping'
      AND dl.decision_outcome = 'mapped'
    ORDER BY dl.timestamp DESC
    LIMIT 1
  ),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text,
  'service_type_mapping decision includes mapping_id'
);

SELECT matches(
  (
    SELECT dl.decision_inputs->>'mapping_id'
    FROM public.decision_log dl
    WHERE dl.resource_type = 'api_gateway_request'
      AND dl.resource_id = '99990000-0000-0000-0000-000000000050'::uuid
      AND dl.decision_point = 'service_level_mapping'
      AND dl.decision_outcome = 'mapped'
    ORDER BY dl.timestamp DESC
    LIMIT 1
  ),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text,
  'service_level_mapping decision includes mapping_id'
);

SELECT is(
  (
    SELECT cod_amount::text
    FROM public.shipments
    WHERE id = (SELECT (result->'postprocess'->>'shipment_id')::uuid FROM tmp_gateway_postprocess)
  ),
  '123.45',
  'postprocess maps COD amount (prefers toCollectFromReceiver)'
);

SELECT is(
  (
    SELECT box_count::text
    FROM public.shipments
    WHERE id = (SELECT (result->'postprocess'->>'shipment_id')::uuid FROM tmp_gateway_postprocess)
  ),
  '2',
  'postprocess maps pkg.quantity to box_count'
);

SELECT is(
  (
    SELECT special_instructions
    FROM public.shipments
    WHERE id = (SELECT (result->'postprocess'->>'shipment_id')::uuid FROM tmp_gateway_postprocess)
  ),
  'Fragile 050',
  'postprocess maps pkg.notes to special_instructions'
);

SELECT is(
  (
    SELECT promised_delivery_date::text
    FROM public.shipments
    WHERE id = (SELECT (result->'postprocess'->>'shipment_id')::uuid FROM tmp_gateway_postprocess)
  ),
  '2020-10-16',
  'postprocess maps expectedDeliveryDate to promised_delivery_date'
);

SELECT is(
  (
    SELECT (raw_input::jsonb #>> '{source_address,nationalAddress}')
    FROM public.addresses
    WHERE id = (SELECT (result->'postprocess'->>'destination_address_id')::uuid FROM tmp_gateway_postprocess)
  ),
  'NAT-DEST-050',
  'address materializer preserves destinationAddress raw object in raw_input'   
);

-- ----------------------------------------------------------------------------
-- Handler edge-case: when toCollectFromReceiver is missing, cod_amount falls back to pkg.cod
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_provider_id UUID;
  v_route_id UUID;
BEGIN
  SELECT r.provider_id, r.id
    INTO v_provider_id, v_route_id
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
   WHERE p.name = 'logestechs_v2_mirror'
     AND upper(r.method) = 'POST'
     AND r.path_template = '/api/ship/request/by-email'
     AND r.scope_type = 'global'
     AND r.enabled = TRUE
   ORDER BY r.updated_at DESC
   LIMIT 1;

  IF v_provider_id IS NULL OR v_route_id IS NULL THEN
    RAISE EXCEPTION 'Seeded Logestechs create route missing (provider/create)';
  END IF;

  INSERT INTO public.api_gateway_requests (
    id,
    organization_id,
    client_id,
    sender_id,
    source_id,
    correlation_id,
    route_id,
    method,
    path,
    query_string,
    request_headers,
    request_body,
    received_at,
    created_at,
    updated_at
  ) VALUES (
    '99990000-0000-0000-0000-000000000051',
    'aaaa0000-0000-0000-0000-000000000050',
    'bbbb0000-0000-0000-0000-000000000050',
    'cccc0000-0000-0000-0000-000000000050',
    'eeee0000-0000-0000-0000-000000000050',
    '77770000-0000-0000-0000-000000000051',
    v_route_id,
    'POST',
    '/api/ship/request/by-email',
    NULL,
    '{}'::jsonb,
    jsonb_build_object(
      'pkg', jsonb_build_object(
        'receiverName', 'QA Receiver 050 COD',
        'receiverPhone', '0500001050',
        'invoiceNumber', 'INV-050-COD',
        'shipmentType', 'COD',
        'serviceType', 'STANDARD',
        'cod', '600',
        'quantity', 1,
        'notes', 'COD fallback 050'
      ),
      'originAddress', jsonb_build_object(
        'addressLine1', 'Test Origin 050 COD',
        'city', 'Riyadh',
        'region', 'Riyadh',
        'country', 'SA'
      ),
      'destinationAddress', jsonb_build_object(
        'addressLine1', 'Test Destination 050 COD',
        'city', 'Riyadh',
        'region', 'Riyadh',
        'country', 'SA'
      )
    ),
    now(),
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO outbound_calls (
    id,
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    status,
    priority,
    retry_count,
    max_retries,
    scheduled_at,
    correlation_id,
    context,
    created_at,
    workflow_run_step_id
  ) VALUES (
    '88880000-0000-0000-0000-000000000051',
    'provider_api',
    'provider',
    v_provider_id,
    'POST',
    'https://example.test/api/ship/request/by-email',
    '{}'::jsonb,
    (SELECT request_body FROM public.api_gateway_requests WHERE id = '99990000-0000-0000-0000-000000000051'),
    'completed',
    100,
    0,
    1,
    now(),
    '77770000-0000-0000-0000-000000000051',
    jsonb_build_object('api_gateway_request_id', '99990000-0000-0000-0000-000000000051'),
    now(),
    '05000000-0000-0000-0000-000000000054'
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.api_gateway_requests
  SET outbound_call_id = '88880000-0000-0000-0000-000000000051',
      updated_at = now()
  WHERE id = '99990000-0000-0000-0000-000000000051';
END;
$$;

CREATE TEMP TABLE tmp_gateway_postprocess_cod AS
SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
  (SELECT oc FROM public.outbound_calls oc WHERE oc.id = '88880000-0000-0000-0000-000000000051'),
  jsonb_build_object(
    'id', 12345651,
    'barcode', 'PGTAP-GW-050-COD'
  )
) AS result;

SELECT is(
  (
    SELECT cod_amount::text
    FROM public.shipments
    WHERE id = (SELECT (result->'postprocess'->>'shipment_id')::uuid FROM tmp_gateway_postprocess_cod)
  ),
  '600',
  'postprocess maps COD amount fallback to pkg.cod when toCollectFromReceiver is missing'
);

SELECT * FROM finish();

ROLLBACK;
