-- Test Suite: API Gateway - Logestechs V2 cancel postprocess (status + client webhook)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);
SET LOCAL pgtap.vendor_company_id = '999999';

-- Ensure time partitions exist for decision_log/settings_resolution_log inserts.
SELECT public.create_next_partitions();

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_route_packs
    WHERE name = 'logestechs_v2_mirror'
      AND enabled = TRUE
  ),
  'logestechs_v2_mirror pack exists and enabled'
);

-- ----------------------------------------------------------------------------
-- Seed minimal fixture (create shipment -> cancel -> verify status + webhook enqueue)
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_provider_id UUID;
  v_create_route_id UUID;
  v_cancel_route_id UUID;

  v_org UUID := 'aaaa0000-0000-0000-0000-000000000052';
  v_client UUID := 'bbbb0000-0000-0000-0000-000000000052';
  v_sender UUID := 'cccc0000-0000-0000-0000-000000000052';
  v_source UUID := 'eeee0000-0000-0000-0000-000000000052';
  v_mapping UUID := 'dddd0000-0000-0000-0000-000000000052';

  v_create_request_id UUID := '99990000-0000-0000-0000-000000000052';
  v_cancel_request_id UUID := '99990000-0000-0000-0000-000000000053';

  v_create_call_id UUID := '88880000-0000-0000-0000-000000000052';
  v_cancel_call_id UUID := '88880000-0000-0000-0000-000000000053';

  v_step_id UUID := '05000000-0000-0000-0000-000000000054';
  v_workflow_id UUID := '05000000-0000-0000-0000-000000000053';
  v_template_id UUID := '05000000-0000-0000-0000-000000000051';
  v_template_step_id UUID := '05000000-0000-0000-0000-000000000052';

  v_create_result JSONB;
  v_cancel_result JSONB;
  v_shipment_id UUID;
  v_webhook_call_id UUID;
BEGIN
  SELECT r.provider_id, r.id
    INTO v_provider_id, v_create_route_id
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
   WHERE p.name = 'logestechs_v2_mirror'
     AND upper(r.method) = 'POST'
     AND r.path_template = '/api/ship/request/by-email'
     AND r.scope_type = 'global'
     AND r.enabled = TRUE
   ORDER BY r.updated_at DESC
   LIMIT 1;

  SELECT r.id
    INTO v_cancel_route_id
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
   WHERE p.name = 'logestechs_v2_mirror'
     AND upper(r.method) = 'PUT'
     AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}/cancel'
     AND r.scope_type = 'global'
     AND r.enabled = TRUE
   ORDER BY r.updated_at DESC
   LIMIT 1;

  IF v_provider_id IS NULL OR v_create_route_id IS NULL OR v_cancel_route_id IS NULL THEN
    RAISE EXCEPTION 'Seeded Logestechs routes missing (provider/create/cancel)';
  END IF;

  -- Seed workflow context so outbound_calls inserts pass engine guard.
  PERFORM set_config('app.workflow_run_id', v_workflow_id::text, true);
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    version,
    status,
    scope_type
  )
  VALUES (
    v_template_id,
    'pgtap_api_gateway_postprocess_052',
    'Fixture workflow for api gateway outbound guard context (052)',
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
    v_template_step_id,
    v_template_id,
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
    v_workflow_id,
    v_template_id,
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
    v_step_id,
    v_workflow_id,
    v_template_step_id,
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

  PERFORM set_config('app.workflow_run_step_id', v_step_id::text, true);
  PERFORM set_config('platform.workflow_engine', '1', true);
  PERFORM set_config('platform.workflow_run_step_id', v_step_id::text, true);

  -- Disable geocoding/label side-effects for deterministic test behavior.
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
  WHERE id = v_create_route_id;

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'API Gateway Org 052', 'pgtap-api-gateway-org-052')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'API Gateway Client 052', 'pgtap-api-gateway-client-052', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'API Gateway Sender 052', 'API Gateway Sender 052', TRUE, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM bootstrap_tenant_onboarding_v1(v_org, 'pgtap:api-gateway-logestechs-v2-cancel-postprocess-fixture-bootstrap');

  INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'pgtap-api-gateway-052::default',
    '{}'::jsonb,
    1,
    'pgTAP api gateway source mapping 052'
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
    v_source,
    v_org,
    'pgtap-api-gateway-source-052',
    'API Gateway Source 052',
    'api_gateway',
    'token-api-gateway-052',
    v_mapping,
    1000,
    TRUE,
    v_sender
  )
  ON CONFLICT (id) DO NOTHING;

  -- Enable client webhook forwarding for this client (allowlist cancelled).
  WITH client_sv AS (
    INSERT INTO settings_versions_p0 (
      category,
      scope_type,
      scope_id,
      scope_hash,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    )
    VALUES (
      'client_webhook_policy',
      'client',
      v_client,
      v_client,
      1,
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'url', 'https://example.invalid/webhooks/logestechs',
        'method', 'POST',
        'headers', jsonb_build_object('content-type', 'application/json'),
        'payload', jsonb_build_object('mode', 'passthrough_raw'),
        'filter', jsonb_build_object('mode', 'allowlist', 'statuses', jsonb_build_array('cancelled'))
      ),
      1,
      'pgtap seed client_webhook_policy (052)',
      now(),
      now()
    )
    RETURNING id, scope_id, scope_hash, value
  )
  INSERT INTO settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    'client_webhook_policy',
    'client',
    scope_id,
    scope_hash,
    id,
    value,
    now()
  FROM client_sv
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = now();

  -- Create request + outbound call (provider_api) for shipment creation.
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
    v_create_request_id,
    v_org,
    v_client,
    v_sender,
    v_source,
    '77770000-0000-0000-0000-000000000052',
    v_create_route_id,
    'POST',
    '/api/ship/request/by-email',
    NULL,
    '{}'::jsonb,
    jsonb_build_object(
      'pkg', jsonb_build_object(
        'receiverName', 'QA Receiver 052',
        'receiverPhone', '+12025550123',
        'invoiceNumber', 'INV-052',
        'shipmentType', 'COD',
        'serviceType', 'STANDARD',
        'cod', '50',
        'quantity', 1,
        'notes', 'Cancel test 052'
      ),
      'originAddress', jsonb_build_object(
        'addressLine1', 'Test Origin 052',
        'city', 'Riyadh',
        'region', 'Riyadh',
        'country', 'SA'
      ),
      'destinationAddress', jsonb_build_object(
        'addressLine1', 'Test Destination 052',
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
    v_create_call_id,
    'provider_api',
    'provider',
    v_provider_id,
    'POST',
    'https://example.test/api/ship/request/by-email',
    '{}'::jsonb,
    (SELECT request_body FROM public.api_gateway_requests WHERE id = v_create_request_id),
    'completed',
    100,
    0,
    1,
    now(),
    '77770000-0000-0000-0000-000000000052',
    jsonb_build_object(
      'api_gateway_request_id', v_create_request_id,
      'api_gateway_route_id', v_create_route_id
    ),
    now(),
    v_step_id
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.api_gateway_requests
  SET outbound_call_id = v_create_call_id,
      updated_at = now()
  WHERE id = v_create_request_id;

  SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
    (SELECT oc FROM public.outbound_calls oc WHERE oc.id = v_create_call_id),
    jsonb_build_object('id', 12345652, 'barcode', 'PGTAP-GW-052-BARCODE')
  )
  INTO v_create_result;

  BEGIN
    v_shipment_id := NULLIF(v_create_result->'postprocess'->>'shipment_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_shipment_id := NULL;
  END;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'Create postprocess did not return shipment_id';
  END IF;

  -- Cancel request + outbound call.
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
    v_cancel_request_id,
    v_org,
    v_client,
    v_sender,
    v_source,
    '77770000-0000-0000-0000-000000000053',
    v_cancel_route_id,
    'PUT',
    format('/api/guests/%s/packages/12345652/cancel', current_setting('pgtap.vendor_company_id')),
    NULL,
    '{}'::jsonb,
    '{}'::jsonb,
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
    v_cancel_call_id,
    'provider_api',
    'provider',
    v_provider_id,
    'PUT',
    format('https://example.test/api/guests/%s/packages/12345652/cancel', current_setting('pgtap.vendor_company_id')),
    '{}'::jsonb,
    '{}'::jsonb,
    'completed',
    100,
    0,
    1,
    now(),
    '77770000-0000-0000-0000-000000000053',
    jsonb_strip_nulls(jsonb_build_object(
      'api_gateway_request_id', v_cancel_request_id,
      'api_gateway_route_id', v_cancel_route_id,
      'api_gateway_path_params', jsonb_build_object(
        'companyId', current_setting('pgtap.vendor_company_id'),
        'shipmentId', '12345652'
      )
    )),
    now(),
    v_step_id
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.api_gateway_requests
  SET outbound_call_id = v_cancel_call_id,
      updated_at = now()
  WHERE id = v_cancel_request_id;

  UPDATE public.outbound_calls
  SET response_status_code = 200
  WHERE id = v_cancel_call_id;

  SELECT workflow_handlers.process_api_gateway_outbound_response_v1(      
    (SELECT oc FROM public.outbound_calls oc WHERE oc.id = v_cancel_call_id),
    '{}'::jsonb
  )
  INTO v_cancel_result;

  BEGIN
    v_webhook_call_id := NULLIF(v_cancel_result->'postprocess'->>'client_webhook_outbound_call_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_call_id := NULL;
  END;

  IF v_webhook_call_id IS NULL THEN
    RAISE EXCEPTION 'Cancel postprocess did not return client_webhook_outbound_call_id';
  END IF;

  CREATE TEMP TABLE tmp_cancel_postprocess AS
  SELECT v_shipment_id AS shipment_id, v_webhook_call_id AS webhook_call_id;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'PUT'
      AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}/cancel'
      AND COALESCE((r.policy #>> '{postprocess,enabled}')::BOOLEAN, FALSE) = TRUE
      AND r.policy #>> '{postprocess,mode}' = 'shipment_cancel_v1'
  ),
  'cancel route has postprocess enabled (shipment_cancel_v1)'
);

SELECT is(
  (
    SELECT status
    FROM public.shipments
    WHERE id = (SELECT shipment_id FROM tmp_cancel_postprocess)
  ),
  'cancelled',
  'cancel postprocess updates shipment.status=cancelled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.id = (SELECT webhook_call_id FROM tmp_cancel_postprocess)
      AND oc.call_type = 'client_webhook'
      AND oc.body->>'newStatus' = 'CANCELLED'
  ),
  'cancel postprocess enqueues client_webhook with newStatus=CANCELLED'
);

SELECT is(
  (
    SELECT body->>'barcode'
    FROM public.outbound_calls
    WHERE id = (SELECT webhook_call_id FROM tmp_cancel_postprocess)
  ),
  '12345652',
  'cancel webhook payload includes barcode=shipmentId'
);

SELECT is(
  (
    SELECT context->>'api_gateway_request_id'
    FROM public.outbound_calls
    WHERE id = (SELECT webhook_call_id FROM tmp_cancel_postprocess)
  ),
  '99990000-0000-0000-0000-000000000053',
  'cancel webhook outbound_call context carries api_gateway_request_id'
);

SELECT * FROM finish();

ROLLBACK;
