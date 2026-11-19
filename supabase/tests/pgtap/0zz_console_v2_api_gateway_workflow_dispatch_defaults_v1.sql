BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

SET search_path TO public, pgtap, extensions;

SELECT has_function(
  'public',
  'get_api_gateway_edge_dispatch_jobs_v1',
  ARRAY['uuid'],
  'API Gateway exposes a narrow workflow-mode edge dispatch helper'
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
    SELECT count(*)::INT
      FROM public.workflow_template_steps wts
      JOIN public.workflow_templates wt
        ON wt.id = wts.workflow_template_id
     WHERE wt.name = 'api_gateway_shipment_create_default_v1'
       AND wts.enabled = TRUE
  ),
  3,
  'default API Gateway shipment-create workflow has materialize, dispatch, and wait steps'
);

SELECT is(
  (
    SELECT count(*)::INT
      FROM public.api_routes ar
     WHERE ar.enabled = TRUE
       AND public.api_gateway_route_canonical_intent_v1(COALESCE(ar.policy, '{}'::jsonb)) = 'shipment.create'
       AND (COALESCE(ar.policy, '{}'::jsonb) ? 'workflow') IS FALSE
  ),
  0,
  'enabled shipment.create API Gateway routes have explicit workflow policy defaults'
);

SELECT has_function(
  'public',
  'apply_api_gateway_shipment_create_workflow_defaults_v1',
  ARRAY[]::TEXT[],
  'API Gateway route defaults trigger function exists'
);

CREATE TEMP TABLE pgtap_api_gateway_default_policy ON COMMIT DROP AS
WITH pack AS (
  INSERT INTO public.api_route_packs (name, description)
  VALUES ('pgtap_api_gateway_workflow_defaults_pack', 'pgTAP workflow default guard')
  RETURNING id
),
route AS (
  INSERT INTO public.api_routes (
    pack_id,
    route_name,
    enabled,
    method,
    path_template,
    policy
  )
  SELECT
    pack.id,
    'pgtap_api_gateway_workflow_defaults_route',
    TRUE,
    'POST',
    '/pgtap/api-gateway/defaults',
    '{"canonical_intent":"shipment.create"}'::jsonb
  FROM pack
  RETURNING policy
)
SELECT policy FROM route;

SELECT is(
  (
    SELECT policy #>> '{workflow,template_name}'
      FROM pgtap_api_gateway_default_policy
     LIMIT 1
  ),
  'api_gateway_shipment_create_default_v1',
  'new enabled shipment.create API routes receive the default workflow template'
);

SELECT throws_ok(
  $$
    WITH pack AS (
      INSERT INTO public.api_route_packs (name, description)
      VALUES ('pgtap_api_gateway_workflow_disabled_pack', 'pgTAP workflow disabled guard')
      RETURNING id
    )
    INSERT INTO public.api_routes (
      pack_id,
      route_name,
      enabled,
      method,
      path_template,
      policy
    )
    SELECT
      pack.id,
      'pgtap_api_gateway_workflow_disabled_route',
      TRUE,
      'POST',
      '/pgtap/api-gateway/disabled',
      '{"canonical_intent":"shipment.create","workflow":{"enabled":false}}'::jsonb
    FROM pack
  $$,
  '23514',
  NULL,
  'enabled shipment.create API routes cannot explicitly disable workflow mode'
);

SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'public.get_api_gateway_edge_dispatch_jobs_v1(uuid)',
    'execute'
  ),
  'edge_api_gateway_role can execute API Gateway edge dispatch helper'
);

SELECT has_function(
  'api',
  'get_api_gateway_edge_dispatch_jobs_v1',
  ARRAY['uuid'],
  'API schema exposes API Gateway edge dispatch helper'
);

SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'api.get_api_gateway_edge_dispatch_jobs_v1(uuid)',
    'execute'
  ),
  'edge_api_gateway_role can execute API schema dispatch helper'
);

SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'public.progress_api_gateway_request_workflow_v1(uuid,uuid,jsonb)',
    'execute'
  ),
  'edge_api_gateway_role can execute the narrow public API Gateway workflow progress helper'
);

SELECT has_function(
  'api',
  'progress_api_gateway_request_workflow_v1',
  ARRAY['uuid', 'uuid', 'jsonb'],
  'API schema exposes narrow API Gateway request/workflow progress helper'
);

SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'api.progress_api_gateway_request_workflow_v1(uuid,uuid,jsonb)',
    'execute'
  ),
  'edge_api_gateway_role can advance API Gateway workflow runs through the narrow API schema helper'
);

SELECT * FROM finish();

ROLLBACK;
