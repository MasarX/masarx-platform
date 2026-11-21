-- Test Suite: Console V2 API Gateway shipment mutation intent guard
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);
SET LOCAL pgtap.vendor_company_id = '999999';

SELECT public.create_next_partitions();

SELECT is(
  public.api_gateway_route_canonical_intent_v1(
    jsonb_build_object('postprocess', jsonb_build_object('mode', 'shipment_update_v1'))
  ),
  'shipment.update',
  'postprocess shipment_update_v1 resolves to shipment.update'
);

SELECT is(
  public.api_gateway_route_canonical_intent_v1(
    jsonb_build_object('postprocess', jsonb_build_object('mode', 'shipment_cancel_v1'))
  ),
  'shipment.delete',
  'postprocess shipment_cancel_v1 resolves to shipment.delete'
);

SELECT is(
  public.api_gateway_route_canonical_intent_v1(
    jsonb_build_object('workflow', jsonb_build_object('intent', 'shipment.status.update'))
  ),
  'update.status',
  'explicit shipment.status.update resolves to update.status'
);

DO $$
DECLARE
  v_org uuid := '65000000-0000-4000-8000-000000000001';
  v_source uuid := '65000000-0000-4000-8000-000000000002';
  v_mapping uuid := '65000000-0000-4000-8000-000000000003';
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'API Gateway Mutation Guard 650', 'api-gateway-mutation-guard-650')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    'webhook_inbound',
    'api-gateway-mutation-guard-650::default',
    '{}'::jsonb,
    1,
    'pgTAP API Gateway mutation guard mapping'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token_hash,
    mapping_config_id,
    rate_limit_per_hour,
    enabled,
    sender_id
  )
  VALUES (
    v_source,
    v_org,
    'api-gateway-mutation-guard-650',
    'API Gateway Mutation Guard 650',
    'api_gateway',
    extensions.crypt('token-api-gateway-mutation-650', extensions.gen_salt('bf')),
    v_mapping,
    1000,
    TRUE,
    NULL
  )
  ON CONFLICT (id) DO UPDATE
    SET auth_token_hash = EXCLUDED.auth_token_hash,
        sender_id = NULL,
        enabled = TRUE,
        updated_at = now();
END;
$$;

CREATE TEMP TABLE tmp_api_gateway_update_guard AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-mutation-650',
  'PUT',
  format('/api/guests/%s/packages/SHIP-MUT-GUARD-650', current_setting('pgtap.vendor_company_id')),
  '',
  jsonb_build_object(
    'content-type', 'application/json',
    'x-webhook-token', 'token-api-gateway-mutation-650',
    'x-correlation-id', '65000000-0000-4000-8000-000000000004'
  ),
  jsonb_build_object('destinationAddress', jsonb_build_object('addressLine1', 'Mutation guard', 'city', 'Riyadh', 'country', 'SA'))
) AS result;

CREATE TEMP TABLE tmp_api_gateway_cancel_guard AS
SELECT public.workflow_intake_api_gateway_v1(
  'token-api-gateway-mutation-650',
  'PUT',
  format('/api/guests/%s/packages/SHIP-MUT-GUARD-650/cancel', current_setting('pgtap.vendor_company_id')),
  '',
  jsonb_build_object(
    'content-type', 'application/json',
    'x-webhook-token', 'token-api-gateway-mutation-650',
    'x-correlation-id', '65000000-0000-4000-8000-000000000005'
  ),
  jsonb_build_object('reason', 'mutation guard')
) AS result;

SELECT is(
  (SELECT result->>'action' FROM tmp_api_gateway_update_guard),
  'error',
  'update route fails closed when source lacks sender/client binding'
);

SELECT is(
  (SELECT (result->>'status')::int FROM tmp_api_gateway_update_guard),
  400,
  'update route missing sender/client returns HTTP 400'
);

SELECT is(
  (SELECT result#>>'{body,error}' FROM tmp_api_gateway_update_guard),
  'api_gateway_source_missing_sender_client',
  'update route returns missing sender/client error'
);

SELECT is(
  (SELECT result#>>'{body,error}' FROM tmp_api_gateway_cancel_guard),
  'api_gateway_source_missing_sender_client',
  'cancel/delete route returns missing sender/client error'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.api_gateway_requests agr
     WHERE agr.source_id = '65000000-0000-4000-8000-000000000002'::uuid
       AND agr.method = 'PUT'
       AND agr.path = format('/api/guests/%s/packages/SHIP-MUT-GUARD-650', current_setting('pgtap.vendor_company_id'))
       AND agr.sender_id IS NULL
       AND agr.client_id IS NULL
  ),
  'rejected update mutation still records redacted request readback'
);

SELECT is(
  (
    SELECT dl.decision_inputs->>'canonical_intent'
      FROM public.decision_log dl
     WHERE dl.resource_type = 'api_gateway_request'
       AND dl.decision_point = 'api_gateway_source_sender_client_checked'
       AND dl.decision_inputs->>'path' = format('/api/guests/%s/packages/SHIP-MUT-GUARD-650', current_setting('pgtap.vendor_company_id'))
     ORDER BY dl.timestamp DESC
     LIMIT 1
  ),
  'shipment.update',
  'decision log records shipment.update canonical intent for rejected update route'
);

SELECT * FROM finish();
ROLLBACK;
