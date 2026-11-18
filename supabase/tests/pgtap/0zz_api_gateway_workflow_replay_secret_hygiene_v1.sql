BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(28);

SET search_path TO public, pgtap, extensions;

SELECT has_function('public', 'api_gateway_sanitize_outbound_headers_v1', ARRAY['jsonb']);

SELECT is(
  public.api_gateway_sanitize_outbound_headers_v1(
    '{"Authorization":"Bearer secret","X-MasarX-Replay-Of":"request-id","Company-Id":"safe-company"}'::jsonb
  ),
  '{"company-id":"safe-company"}'::jsonb,
  'provider egress strips authorization and replay lineage while preserving explicit provider headers'
);

SELECT is(
  public.api_gateway_sanitize_outbound_headers_v1('"legacy-malformed-headers"'::jsonb),
  '"REDACTED"'::jsonb,
  'provider egress header sanitizer fails closed for malformed historical JSON'
);

SELECT is(
  public.api_gateway_sanitize_outbound_headers_v1(NULL),
  NULL,
  'provider egress header sanitizer preserves SQL NULL'
);

SELECT has_function('public', 'api_gateway_strip_body_field_auth_v1', ARRAY['jsonb', 'jsonb']);

SELECT is(
  public.api_gateway_strip_body_field_auth_v1(
    '{"email":"secret@example.test","password":"secret-value","shipment":{"reference":"safe"}}'::jsonb,
    '{"username":"email","password":"password"}'::jsonb
  ),
  '{"shipment":{"reference":"safe"}}'::jsonb,
  'mapped provider credential keys and provider field aliases are removed before persistence'
);

SELECT has_trigger(
  'public',
  'outbound_calls',
  'trg_api_gateway_outbound_secret_guard_v1',
  'outbound API Gateway calls enforce secret hygiene before persistence'
);

SELECT has_trigger(
  'public',
  'workflow_runs',
  'trg_api_gateway_workflow_secret_guard_v1',
  'API Gateway workflow context enforces secret hygiene before persistence'
);

SELECT is(
  public.api_gateway_policy_intent_v1('{"workflow":{"intent":"shipment.created"}}'::jsonb),
  'shipment.create',
  'nested workflow intent resolves to shipment.create'
);

SELECT is(
  public.api_gateway_policy_intent_v1('{"postprocess":{"mode":"shipment_create_v1"}}'::jsonb),
  'shipment.create',
  'legacy postprocess mode resolves to shipment.create without path matching'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workflow_templates
    WHERE name = 'api_gateway_shipment_create_default_v1'
      AND status = 'active'
  ),
  'default API Gateway shipment-create workflow template is active'
);

SELECT is(
  (
    SELECT count(*)::INTEGER
    FROM public.workflow_template_steps step
    JOIN public.workflow_templates template ON template.id = step.workflow_template_id
    WHERE template.name = 'api_gateway_shipment_create_default_v1'
      AND step.enabled
  ),
  3,
  'default shipment-create workflow keeps materialize, dispatch, and wait sequence'
);

SELECT has_function(
  'public',
  'apply_api_gateway_shipment_create_workflow_defaults_v1',
  ARRAY[]::TEXT[]
);

CREATE TEMP TABLE pgtap_api_gateway_workflow_default ON COMMIT DROP AS
WITH pack AS (
  INSERT INTO public.api_route_packs (name, description)
  VALUES ('pgtap_api_gateway_workflow_replay_pack', 'API Gateway workflow replay contract')
  RETURNING id
), route AS (
  INSERT INTO public.api_routes (pack_id, route_name, enabled, method, path_template, policy)
  SELECT
    pack.id,
    'pgtap_api_gateway_workflow_replay_route',
    TRUE,
    'POST',
    '/pgtap/api-gateway/workflow-replay',
    '{"workflow":{"intent":"shipment.create"}}'::jsonb
  FROM pack
  RETURNING policy
)
SELECT policy FROM route;

SELECT is(
  (SELECT policy #>> '{workflow,template_name}' FROM pgtap_api_gateway_workflow_default LIMIT 1),
  'api_gateway_shipment_create_default_v1',
  'new shipment.create routes receive the canonical default workflow template'
);

SELECT is(
  (SELECT policy #>> '{delivery,mode}' FROM pgtap_api_gateway_workflow_default LIMIT 1),
  'accepted_async',
  'new shipment.create routes use accepted_async delivery'
);

SELECT throws_ok(
  $$
    WITH pack AS (
      INSERT INTO public.api_route_packs (name, description)
      VALUES ('pgtap_api_gateway_workflow_disabled_pack', 'Disabled API Gateway workflow guard')
      RETURNING id
    )
    INSERT INTO public.api_routes (pack_id, route_name, enabled, method, path_template, policy)
    SELECT
      pack.id,
      'pgtap_api_gateway_workflow_disabled_route',
      TRUE,
      'POST',
      '/pgtap/api-gateway/workflow-disabled',
      '{"workflow":{"intent":"shipment.create","enabled":false}}'::jsonb
    FROM pack
  $$,
  '23514',
  NULL,
  'enabled shipment.create routes cannot disable workflow mode'
);

SELECT has_function('public', 'get_api_gateway_edge_dispatch_jobs_v1', ARRAY['uuid']);
SELECT has_function('api', 'get_api_gateway_edge_dispatch_jobs_v1', ARRAY['uuid']);
SELECT has_function('public', 'progress_api_gateway_request_workflow_v1', ARRAY['uuid', 'uuid', 'jsonb']);
SELECT has_function('api', 'progress_api_gateway_request_workflow_v1', ARRAY['uuid', 'uuid', 'jsonb']);

SELECT ok(
  has_function_privilege('edge_api_gateway_role', 'public.get_api_gateway_edge_dispatch_jobs_v1(uuid)', 'execute'),
  'edge API Gateway role can resolve only its linked pending dispatch job'
);

SELECT ok(
  has_function_privilege('edge_api_gateway_role', 'api.get_api_gateway_edge_dispatch_jobs_v1(uuid)', 'execute'),
  'edge API Gateway role can call the API-schema dispatch wrapper'
);

SELECT ok(
  has_function_privilege('edge_api_gateway_role', 'public.progress_api_gateway_request_workflow_v1(uuid,uuid,jsonb)', 'execute'),
  'edge API Gateway role can advance a request-linked workflow'
);

SELECT ok(
  has_function_privilege('edge_api_gateway_role', 'api.progress_api_gateway_request_workflow_v1(uuid,uuid,jsonb)', 'execute'),
  'edge API Gateway role can call the API-schema workflow progress wrapper'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.progress_api_gateway_request_workflow_v1(uuid,uuid,jsonb)', 'execute'),
  'anonymous callers cannot advance API Gateway workflows'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.progress_api_gateway_request_workflow_v1(uuid,uuid,jsonb)', 'execute'),
  'authenticated callers cannot advance API Gateway workflows directly'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.get_api_gateway_edge_dispatch_jobs_v1(uuid)', 'execute'),
  'anonymous callers cannot enumerate API Gateway dispatch jobs'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'api.get_api_gateway_edge_dispatch_jobs_v1(uuid)', 'execute'),
  'authenticated callers cannot enumerate API Gateway dispatch jobs'
);

SELECT * FROM finish();

ROLLBACK;
