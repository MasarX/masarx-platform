-- Test Suite: API Gateway - Logestechs V2 update route contract
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

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

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.api_routes r
      JOIN public.api_route_packs p ON p.id = r.pack_id
     WHERE p.name = 'logestechs_v2_mirror'
       AND upper(r.method) = 'PUT'
       AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}'
       AND r.scope_type = 'global'
       AND r.enabled = TRUE
  ),
  'canonical Logestechs update route exists'
);

SELECT is(
  (
    SELECT r.policy #>> '{postprocess,mode}'
      FROM public.api_routes r
      JOIN public.api_route_packs p ON p.id = r.pack_id
     WHERE p.name = 'logestechs_v2_mirror'
       AND upper(r.method) = 'PUT'
       AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}'
       AND r.scope_type = 'global'
       AND r.enabled = TRUE
     ORDER BY r.updated_at DESC
     LIMIT 1
  ),
  'shipment_update_v1',
  'canonical Logestechs update route uses shipment_update_v1 postprocess mode'
);

DO $$
DECLARE
  v_provider_id UUID;
  v_org UUID := 'aaaa0000-0000-0000-0000-000000000055';
  v_client UUID := 'bbbb0000-0000-0000-0000-000000000055';
  v_sender UUID := 'cccc0000-0000-0000-0000-000000000055';
  v_source UUID := 'eeee0000-0000-0000-0000-000000000055';
  v_mapping UUID := 'dddd0000-0000-0000-0000-000000000055';
  v_workflow_id UUID := '05550000-0000-0000-0000-000000000051';
  v_template_id UUID := '05550000-0000-0000-0000-000000000052';
  v_template_step_id UUID := '05550000-0000-0000-0000-000000000053';
  v_step_id UUID := '05550000-0000-0000-0000-000000000054';
BEGIN
  SELECT r.provider_id
    INTO v_provider_id
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
   WHERE p.name = 'logestechs_v2_mirror'
     AND upper(r.method) = 'PUT'
     AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}'
     AND r.scope_type = 'global'
     AND r.enabled = TRUE
   ORDER BY r.updated_at DESC
   LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'Canonical Logestechs update route missing provider';
  END IF;

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'API Gateway Org 055', 'pgtap-api-gateway-org-055')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'API Gateway Client 055', 'pgtap-api-gateway-client-055', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'API Gateway Sender 055', 'API Gateway Sender 055', TRUE, 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM bootstrap_tenant_onboarding_v1(v_org, 'pgtap:api-gateway-logestechs-v2-update-contract-fixture-bootstrap');

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'pgtap-api-gateway-055::default',
    '{}'::jsonb,
    1,
    'pgTAP api gateway source mapping 055'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
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
    'pgtap-api-gateway-source-055',
    'API Gateway Source 055',
    'api_gateway',
    'token-api-gateway-055',
    v_mapping,
    1000,
    TRUE,
    v_sender
  )
  ON CONFLICT (id) DO NOTHING;

  WITH secret AS (
    SELECT vault.create_secret(
      '{"username":"user055@example.test","password":"pass055"}',
      'provider_auth_configs/11110000-0000-0000-0000-000000000055',
      'pgtap api gateway update basic_auth 055',
      NULL
    ) AS id
  )
  INSERT INTO public.provider_auth_configs (
    id,
    provider_id,
    auth_type,
    credentials_vault_id,
    credentials,
    expires_at
  )
  SELECT
    '11110000-0000-0000-0000-000000000055',
    v_provider_id,
    'basic_auth',
    secret.id,
    NULL,
    NULL
  FROM secret
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settings_versions_p0 (
    id,
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
    '77770000-0000-0000-0000-000000000055',
    'logestechs_v2_account',
    'source',
    v_source,
    v_source,
    1,
    jsonb_build_object(
      'auth_config_id', '11110000-0000-0000-0000-000000000055',
      'company_id', '362',
      'enabled', TRUE
    ),
    1,
    'pgTAP seed logestechs_v2_account for source 055',
    now(),
    now()
  )
  ON CONFLICT (id, scope_hash) DO NOTHING;

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'logestechs_v2_account',
    'source',
    v_source,
    v_source,
    '77770000-0000-0000-0000-000000000055',
    jsonb_build_object(
      'auth_config_id', '11110000-0000-0000-0000-000000000055',
      'company_id', '362',
      'enabled', TRUE
    ),
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;

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
    'pgtap_api_gateway_update_055',
    'Fixture workflow for api gateway update guard context (055)',
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
END;
$$;

CREATE TEMP TABLE tmp_uc178_update_resolve AS
SELECT public.resolve_api_route_v1(
  'PUT',
  '/api/guests/362/packages/SHIP055',
  'aaaa0000-0000-0000-0000-000000000055',
  'bbbb0000-0000-0000-0000-000000000055',
  'cccc0000-0000-0000-0000-000000000055',
  'eeee0000-0000-0000-0000-000000000055'
) AS result;

CREATE TEMP TABLE tmp_uc178_cancel_resolve AS
SELECT public.resolve_api_route_v1(
  'PUT',
  '/api/guests/362/packages/SHIP055/cancel',
  'aaaa0000-0000-0000-0000-000000000055',
  'bbbb0000-0000-0000-0000-000000000055',
  'cccc0000-0000-0000-0000-000000000055',
  'eeee0000-0000-0000-0000-000000000055'
) AS result;

CREATE TEMP TABLE tmp_uc178_update_intake AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-055',
  'PUT',
  '/api/guests/362/packages/SHIP055',
  '',
  jsonb_build_object(
    'content-type', 'application/json',
    'x-webhook-token', 'token-api-gateway-055'
  ),
  jsonb_build_object(
    'email', 'client055@example.test',
    'password', 'client-pass-055',
    'destinationAddress', jsonb_build_object(
      'addressLine1', 'New Update Street',
      'city', 'Jeddah',
      'region', 'Makkah',
      'country', 'SA'
    )
  )
) AS result;

SELECT is(
  (
    SELECT result->>'route_id'
      FROM tmp_uc178_update_resolve
  ),
  (
    SELECT r.id::text
      FROM public.api_routes r
      JOIN public.api_route_packs p ON p.id = r.pack_id
     WHERE p.name = 'logestechs_v2_mirror'
       AND upper(r.method) = 'PUT'
       AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}'
       AND r.scope_type = 'global'
       AND r.enabled = TRUE
     ORDER BY r.updated_at DESC
     LIMIT 1
  ),
  'resolve_api_route_v1 matches canonical update route'
);

SELECT is(
  (SELECT result->'path_params'->>'shipmentId' FROM tmp_uc178_update_resolve),
  'SHIP055',
  'resolve_api_route_v1 extracts shipmentId for update route'
);

SELECT is(
  (
    SELECT result->>'route_id'
      FROM tmp_uc178_cancel_resolve
  ),
  (
    SELECT r.id::text
      FROM public.api_routes r
      JOIN public.api_route_packs p ON p.id = r.pack_id
     WHERE p.name = 'logestechs_v2_mirror'
       AND upper(r.method) = 'PUT'
       AND r.path_template = '/api/guests/{companyId}/packages/{shipmentId}/cancel'
       AND r.scope_type = 'global'
       AND r.enabled = TRUE
     ORDER BY r.updated_at DESC
     LIMIT 1
  ),
  'resolve_api_route_v1 keeps cancel route distinct from update route'
);

SELECT is(
  (SELECT result->>'action' FROM tmp_uc178_update_intake),
  'accepted_async',
  'workflow_intake_api_gateway_v1 accepts canonical update route asynchronously'
);

SELECT is(
  (SELECT (result->>'status')::INT FROM tmp_uc178_update_intake),
  202,
  'canonical update intake returns accepted status'
);

SELECT ok(
  (SELECT public.mapping_studio_try_uuid_v1(result->>'api_gateway_request_id') IS NOT NULL
     AND public.mapping_studio_try_uuid_v1(result->>'workflow_run_id') IS NOT NULL
     AND result->'body'->>'api_gateway_request_id' = result->>'api_gateway_request_id'
     AND result->'body'->>'workflow_run_id' = result->>'workflow_run_id'
   FROM tmp_uc178_update_intake),
  'canonical update intake returns request and workflow lineage'
);

SELECT is(
  (
    SELECT wr.workflow_status
      FROM public.workflow_runs wr
     WHERE wr.id = (SELECT (result->>'workflow_run_id')::uuid FROM tmp_uc178_update_intake)
  ),
  'pending',
  'canonical update intake starts pending workflow run'
);

SELECT ok(
  (
    SELECT wr.context #>> '{api_gateway,upstream_method}' = 'PUT'
       AND wr.context #>> '{api_gateway,upstream_url}' = 'https://apisv2.logestechs.com/api/guests/362/packages/SHIP055'
       AND wr.context #>> '{api_gateway,outbound_headers,company-id}' = '362'
       AND wr.context #>> '{api_gateway,path_params,shipmentId}' = 'SHIP055'
       AND wr.context #>> '{api_gateway,provider_account_category}' = 'logestechs_v2_account'
      FROM public.workflow_runs wr
     WHERE wr.id = (SELECT (result->>'workflow_run_id')::uuid FROM tmp_uc178_update_intake)
  ),
  'canonical update intake preserves provider dispatch context on workflow run'
);

SELECT ok(
  (
    SELECT wrs.operation_name = 'dispatch_update'
       AND wrs.handler_key = 'api_gateway_dispatch_outbound'
       AND wrs.step_status = 'pending'
      FROM public.workflow_run_steps wrs
     WHERE wrs.workflow_run_id = (SELECT (result->>'workflow_run_id')::uuid FROM tmp_uc178_update_intake)
     ORDER BY wrs.sequence_order
     LIMIT 1
  ),
  'canonical update intake queues workflow dispatch step'
);

SELECT ok(
  (
    SELECT NOT (wr.context #> '{api_gateway,request_body}' ? 'email')
       AND NOT (wr.context #> '{api_gateway,request_body}' ? 'password')
      FROM public.workflow_runs wr
     WHERE wr.id = (SELECT (result->>'workflow_run_id')::uuid FROM tmp_uc178_update_intake)
  ),
  'canonical update intake strips auth body fields from workflow dispatch payload'
);

SELECT * FROM finish();
ROLLBACK;
