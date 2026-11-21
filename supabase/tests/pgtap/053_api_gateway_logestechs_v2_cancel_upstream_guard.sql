-- Test Suite: API Gateway - Logestechs V2 cancel postprocess upstream guard (no side-effects on upstream failure)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);
SET LOCAL pgtap.vendor_company_id = '999999';

-- Ensure time partitions exist for decision_log/settings_resolution_log inserts (handler uses decision logging).
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

DO $$
DECLARE
  v_provider_id UUID;
  v_cancel_route_id UUID;

  v_org UUID := 'aaaa0000-0000-0000-0000-000000000053';
  v_client UUID := 'bbbb0000-0000-0000-0000-000000000053';
  v_sender UUID := 'cccc0000-0000-0000-0000-000000000053';
  v_source UUID := 'eeee0000-0000-0000-0000-000000000053';
  v_mapping UUID := 'dddd0000-0000-0000-0000-000000000053';

  v_shipment_id UUID := '11110000-0000-0000-0000-000000000053';
  v_request_id UUID := '99990000-0000-0000-0000-000000000053';
  v_call_id UUID := '88880000-0000-0000-0000-000000000053';

  v_step_id UUID := '05300000-0000-0000-0000-000000000054';
  v_workflow_id UUID := '05300000-0000-0000-0000-000000000053';
  v_template_id UUID := '05300000-0000-0000-0000-000000000051';
  v_template_step_id UUID := '05300000-0000-0000-0000-000000000052';

  v_cancel_result JSONB;
BEGIN
  SELECT r.provider_id, r.id
    INTO v_provider_id, v_cancel_route_id
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
   WHERE p.name = 'logestechs_v2_mirror'
     AND upper(r.method) = 'PUT'
     AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}/cancel'
     AND r.scope_type = 'global'
     AND r.enabled = TRUE
   ORDER BY r.updated_at DESC
   LIMIT 1;

  IF v_provider_id IS NULL OR v_cancel_route_id IS NULL THEN
    RAISE EXCEPTION 'Seeded Logestechs cancel route missing';
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
    'pgtap_api_gateway_cancel_guard_053',
    'Fixture workflow for api gateway cancel upstream guard test (053)',
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

  -- Core scoped entities.
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'API Gateway Org 053', 'pgtap-api-gateway-org-053')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'API Gateway Client 053', 'pgtap-api-gateway-client-053', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'API Gateway Sender 053', 'API Gateway Sender 053', TRUE, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM bootstrap_tenant_onboarding_v1(v_org, 'pgtap:api-gateway-logestechs-v2-cancel-upstream-guard-fixture-bootstrap');

  INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'pgtap-api-gateway-053::default',
    '{}'::jsonb,
    1,
    'pgTAP api gateway source mapping 053'
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
    'pgtap-api-gateway-source-053',
    'API Gateway Source 053',
    'api_gateway',
    'token-api-gateway-053',
    v_mapping,
    1000,
    TRUE,
    v_sender
  )
  ON CONFLICT (id) DO NOTHING;

  -- Enable client webhook forwarding for this client (so if the upstream guard regresses, we'd enqueue a webhook).
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
      'pgtap seed client_webhook_policy (053)',
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

  -- Seed a shipment that would be cancelled if the postprocess ran.
  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    sender_id,
    service_type,
    tracking_number,
    box_count,
    status,
    status_updated_at,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment_id,
    v_org,
    v_client,
    v_sender,
    'delivery',
    'CANCEL-053',
    1,
    'pending',
    now(),
    '{}'::jsonb,
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  -- Cancel request + outbound call with an upstream failure (non-2xx).
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
  )
  VALUES (
    v_request_id,
    v_org,
    v_client,
    v_sender,
    v_source,
    '77770000-0000-0000-0000-000000000053',
    v_cancel_route_id,
    'PUT',
    format('/api/guests/%s/packages/CANCEL-053/cancel', current_setting('pgtap.vendor_company_id')),
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
    response_status_code,
    context,
    created_at,
    workflow_run_step_id
  ) VALUES (
    v_call_id,
    'provider_api',
    'provider',
    v_provider_id,
    'PUT',
    format('https://example.test/api/guests/%s/packages/CANCEL-053/cancel', current_setting('pgtap.vendor_company_id')),
    '{}'::jsonb,
    '{}'::jsonb,
    'completed',
    100,
    0,
    1,
    now(),
    '77770000-0000-0000-0000-000000000053',
    400,
    jsonb_strip_nulls(jsonb_build_object(
      'api_gateway_request_id', v_request_id,
      'api_gateway_route_id', v_cancel_route_id,
      'api_gateway_path_params', jsonb_build_object(
        'companyId', current_setting('pgtap.vendor_company_id'),
        'shipmentId', 'CANCEL-053'
      )
    )),
    now(),
    v_step_id
  )
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.api_gateway_requests
  SET outbound_call_id = v_call_id,
      updated_at = now()
  WHERE id = v_request_id;

  SELECT workflow_handlers.process_api_gateway_outbound_response_v1(
    (SELECT oc FROM public.outbound_calls oc WHERE oc.id = v_call_id),
    '{}'::jsonb
  )
  INTO v_cancel_result;

  CREATE TEMP TABLE tmp_cancel_upstream_guard AS
  SELECT v_shipment_id AS shipment_id, v_request_id AS request_id, v_cancel_result AS result;
END;
$$;

SELECT is(
  (SELECT result->'postprocess'->>'status' FROM tmp_cancel_upstream_guard),
  'skipped',
  'cancel postprocess is skipped on upstream failure'
);

SELECT is(
  (SELECT result->'postprocess'->>'reason' FROM tmp_cancel_upstream_guard),
  'upstream_not_successful',
  'cancel postprocess skip reason is upstream_not_successful'
);

SELECT is(
  (
    SELECT status
    FROM public.shipments
    WHERE id = (SELECT shipment_id FROM tmp_cancel_upstream_guard)
  ),
  'pending',
  'shipment.status remains pending when upstream cancel fails'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.outbound_calls oc
    WHERE oc.call_type = 'client_webhook'
      AND oc.shipment_id = (SELECT shipment_id FROM tmp_cancel_upstream_guard)
  ),
  0::INT,
  'no client_webhook is enqueued when upstream cancel fails'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.decision_log
    WHERE organization_id = 'aaaa0000-0000-0000-0000-000000000053'
      AND resource_type = 'api_gateway_request'
      AND resource_id = (SELECT request_id FROM tmp_cancel_upstream_guard)
      AND decision_point = 'shipment_cancel_upstream'
      AND decision_outcome = 'skipped'
  ),
  'decision_log records shipment_cancel_upstream skipped'
);

SELECT * FROM finish();

ROLLBACK;
