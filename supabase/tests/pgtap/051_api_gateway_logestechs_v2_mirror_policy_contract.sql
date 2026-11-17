-- Test Suite: API Gateway - Logestechs V2 mirror policy contract (company-id + provider_account)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_route_packs
    WHERE name = 'logestechs_v2_mirror'
      AND enabled = TRUE
  ),
  'logestechs_v2_mirror pack exists and enabled'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND r.enabled = TRUE
  ),
  (
    SELECT count(*)
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND r.enabled = TRUE
      AND r.policy #>> '{headers,overrides,company-id}' = '{{provider_account.company_id}}'
  ),
  'all Logestechs V2 mirror routes enforce company-id via headers.overrides template'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND r.enabled = TRUE
  ),
  (
    SELECT count(*)
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND r.enabled = TRUE
      AND r.policy #>> '{provider_account,category}' = 'logestechs_v2_account'
      AND COALESCE((r.policy #>> '{provider_account,required}')::BOOLEAN, FALSE) = TRUE
      AND COALESCE((r.policy #>> '{provider_account,require_company_id}')::BOOLEAN, FALSE) = TRUE
  ),
  'all Logestechs V2 mirror routes bind provider_account via ladder (logestechs_v2_account)'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND r.enabled = TRUE
      AND jsonb_typeof(r.policy #> '{headers,defaults}') = 'object'
      AND (r.policy #> '{headers,defaults}' ? 'company-id')
  ),
  0::bigint,
  'no Logestechs V2 mirror route hardcodes company-id in headers.defaults'
);

SELECT is(
  (
    SELECT r.policy #>> '{workflow,template_name}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND r.enabled = TRUE
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  'api_gateway_logestechs_v2_create_geocode_first_v1',
  'Logestechs create shipment route uses geocode-first workflow template'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND r.enabled = TRUE
      AND upper(r.method) = 'POST'
      AND r.path_template = '/api/ship/request/by-email'
      AND COALESCE((r.policy #>> '{workflow,enabled}')::BOOLEAN, FALSE) = TRUE
      AND r.policy #>> '{delivery,mode}' = 'accepted_async'
      AND COALESCE((r.policy #>> '{postprocess,geocoding,enabled}')::BOOLEAN, TRUE) = FALSE
  ),
  'Logestechs create shipment route is workflow-gated (accepted_async) with postprocess geocoding disabled'
);

SELECT * FROM finish();

ROLLBACK;

