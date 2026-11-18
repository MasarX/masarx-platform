-- pgTAP: accepted-async API Gateway routes propagate route timeout policy
-- into outbound api-caller dispatch context.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '4cb9c0bc-a070-4f07-9c29-315c5f9a1b71'::uuid,
  'Console V2 API Gateway Timeout Org',
  'console-v2-api-gateway-timeout-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.providers (
  id,
  organization_id,
  name,
  provider_type,
  enabled,
  priority_rank,
  health_status,
  metadata
)
VALUES (
  '86c82571-b9c6-4fc9-bbb3-f99f8553d6f6'::uuid,
  '4cb9c0bc-a070-4f07-9c29-315c5f9a1b71'::uuid,
  'Console V2 timeout provider',
  'delivery',
  true,
  100,
  'healthy',
  '{"base_url":"http://rvzwwjlztwwisjthghnipgjr.example.invalid:49956"}'::jsonb
)
ON CONFLICT (id) DO UPDATE
SET metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO public.api_route_packs (
  id,
  name,
  description,
  enabled,
  scope_type,
  scope_id
)
VALUES (
  '7fd4d32b-ccda-4c46-b2f5-1ca25f150b61'::uuid,
  'console-v2-timeout-pack',
  'Console V2 timeout proof pack',
  true,
  'tenant',
  '4cb9c0bc-a070-4f07-9c29-315c5f9a1b71'::uuid
)
ON CONFLICT (id) DO UPDATE
SET enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO public.api_routes (
  id,
  pack_id,
  route_name,
  enabled,
  method,
  path_template,
  scope_type,
  scope_id,
  provider_id,
  upstream_method,
  upstream_path_template,
  policy
)
VALUES (
  '357a828c-69c0-4d0e-b160-80a0ea50380d'::uuid,
  '7fd4d32b-ccda-4c46-b2f5-1ca25f150b61'::uuid,
  'console_v2_timeout_route',
  true,
  'POST',
  '/api/console-v2/timeout-proof',
  'tenant',
  '4cb9c0bc-a070-4f07-9c29-315c5f9a1b71'::uuid,
  '86c82571-b9c6-4fc9-bbb3-f99f8553d6f6'::uuid,
  'POST',
  '/provider/timeout',
  jsonb_build_object(
    'delivery', jsonb_build_object(
      'mode', 'accepted_async',
      'status_code', 202,
      'timeout_seconds', 2,
      'headers', jsonb_build_object('content-type', 'application/json')
    ),
    'postprocess', jsonb_build_object('mode', 'shipment_create_v1', 'enabled', true),
    'provider_account', jsonb_build_object('required', false)
  )
)
ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
SET policy = EXCLUDED.policy,
    provider_id = EXCLUDED.provider_id,
    upstream_path_template = EXCLUDED.upstream_path_template,
    updated_at = now();

INSERT INTO public.outbound_calls (
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
  max_retries,
  scheduled_at,
  correlation_id,
  context
)
VALUES (
  '0eaf5d2d-4b34-49dd-8f7c-49703a75a209'::uuid,
  'provider_api',
  'provider',
  '86c82571-b9c6-4fc9-bbb3-f99f8553d6f6'::uuid,
  'POST',
  'http://rvzwwjlztwwisjthghnipgjr.example.invalid:49956/provider/timeout',
  '{}'::jsonb,
  '{}'::jsonb,
  'pending_edge',
  100,
  1,
  now(),
  '1cce8f88-0f95-4f0e-9852-f8f1c59c6fef'::uuid,
  jsonb_build_object(
    'organization_id', '4cb9c0bc-a070-4f07-9c29-315c5f9a1b71',
    'api_gateway_route_id', (
      SELECT id
        FROM public.api_routes
       WHERE method = 'POST'
         AND path_template = '/api/console-v2/timeout-proof'
         AND scope_type = 'tenant'
         AND scope_id = '4cb9c0bc-a070-4f07-9c29-315c5f9a1b71'::uuid
       LIMIT 1
    )
  )
)
ON CONFLICT (id) DO UPDATE
SET context = EXCLUDED.context,
    status = EXCLUDED.status,
    updated_at = now();

SELECT is(
  (
    SELECT context #>> '{edge_dispatch,timeout_seconds}'
      FROM public.outbound_calls
     WHERE id = '0eaf5d2d-4b34-49dd-8f7c-49703a75a209'::uuid
  ),
  '2',
  'API Gateway accepted-async outbound job inherits route delivery timeout'
);

UPDATE public.outbound_calls
   SET context = jsonb_build_object(
     'organization_id', '4cb9c0bc-a070-4f07-9c29-315c5f9a1b71',
     'api_gateway_route_id', (
       SELECT id
         FROM public.api_routes
        WHERE method = 'POST'
          AND path_template = '/api/console-v2/timeout-proof'
          AND scope_type = 'tenant'
          AND scope_id = '4cb9c0bc-a070-4f07-9c29-315c5f9a1b71'::uuid
        LIMIT 1
     ),
     'edge_dispatch', jsonb_build_object('timeout_seconds', 7)
   )
 WHERE id = '0eaf5d2d-4b34-49dd-8f7c-49703a75a209'::uuid;

SELECT is(
  (
    SELECT context #>> '{edge_dispatch,timeout_seconds}'
      FROM public.outbound_calls
     WHERE id = '0eaf5d2d-4b34-49dd-8f7c-49703a75a209'::uuid
  ),
  '7',
  'existing explicit outbound timeout is not overwritten'
);

SELECT ok(
  pg_get_functiondef('public.apply_api_gateway_outbound_timeout_context_v1()'::regprocedure)
    LIKE '%api_gateway_route_id%',
  'timeout trigger resolves route id from API Gateway outbound context'
);

SELECT ok(
  pg_get_functiondef('public.apply_api_gateway_outbound_timeout_context_v1()'::regprocedure)
    LIKE '%delivery,timeout_seconds%',
  'timeout trigger reads route delivery timeout policy'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'trg_api_gateway_outbound_timeout_context_v1'
       AND tgrelid = 'public.outbound_calls'::regclass
       AND NOT tgisinternal
  ),
  'outbound_calls trigger is installed'
);

SELECT is(
  public.get_outbound_edge_dispatch_timeout_v1('0eaf5d2d-4b34-49dd-8f7c-49703a75a209'::uuid),
  7,
  'public timeout resolver returns explicit queued edge-dispatch timeout'
);

SELECT is(
  api.get_outbound_edge_dispatch_timeout_v1('0eaf5d2d-4b34-49dd-8f7c-49703a75a209'::uuid),
  7,
  'api timeout resolver exposes queued timeout to api-caller'
);

SELECT ok(
  has_function_privilege('service_role', 'api.get_outbound_edge_dispatch_timeout_v1(uuid)', 'EXECUTE'),
  'service_role can execute api timeout resolver'
);

SELECT * FROM finish();

ROLLBACK;
