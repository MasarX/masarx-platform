-- Test Suite: API Gateway - Logestechs V2 read routes (proxy contract)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

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
-- Read endpoints (GET): must exist, be proxy-mode, and have postprocess disabled
-- ----------------------------------------------------------------------------

-- GET /api/addresses/villages
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/addresses/villages'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
  ),
  'read route exists: GET /api/addresses/villages'
);

SELECT is(
  (
    SELECT r.policy #>> '{delivery,mode}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/addresses/villages'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  'proxy',
  'villages route delivery.mode=proxy'
);

SELECT is(
  (
    SELECT r.policy #>> '{headers,overrides,company-id}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/addresses/villages'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '{{provider_account.company_id}}',
  'villages route enforces company-id override (template)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/addresses/villages'
      AND COALESCE((r.policy #>> '{postprocess,enabled}')::BOOLEAN, FALSE) = FALSE
  ),
  'villages route has postprocess disabled'
);

-- GET /api/guests/packages/status
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/packages/status'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
  ),
  'read route exists: GET /api/guests/packages/status'
);

SELECT is(
  (
    SELECT r.policy #>> '{delivery,mode}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/packages/status'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  'proxy',
  'status route delivery.mode=proxy'
);

SELECT is(
  (
    SELECT r.policy #>> '{headers,overrides,company-id}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/packages/status'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '{{provider_account.company_id}}',
  'status route enforces company-id override (template)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/packages/status'
      AND COALESCE((r.policy #>> '{postprocess,enabled}')::BOOLEAN, FALSE) = FALSE
  ),
  'status route has postprocess disabled'
);

-- GET /api/guests/companies/info-by-domain
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/companies/info-by-domain'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
  ),
  'read route exists: GET /api/guests/companies/info-by-domain'
);

SELECT is(
  (
    SELECT r.policy #>> '{delivery,mode}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/companies/info-by-domain'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  'proxy',
  'company info route delivery.mode=proxy'
);

SELECT is(
  (
    SELECT r.policy #>> '{headers,overrides,company-id}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/companies/info-by-domain'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '{{provider_account.company_id}}',
  'company info route enforces company-id override (template)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/companies/info-by-domain'
      AND COALESCE((r.policy #>> '{postprocess,enabled}')::BOOLEAN, FALSE) = FALSE
  ),
  'company info route has postprocess disabled'
);

-- GET /api/guests/{companyId}/packages/tracking
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/{companyId}/packages/tracking'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
  ),
  'read route exists: GET /api/guests/{companyId}/packages/tracking'
);

SELECT is(
  (
    SELECT r.policy #>> '{delivery,mode}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/{companyId}/packages/tracking'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  'proxy',
  'tracking route delivery.mode=proxy'
);

SELECT is(
  (
    SELECT r.policy #>> '{headers,overrides,company-id}'
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/{companyId}/packages/tracking'
      AND r.scope_type = 'global'
      AND r.enabled = TRUE
    ORDER BY r.updated_at DESC
    LIMIT 1
  ),
  '{{provider_account.company_id}}',
  'tracking route enforces company-id override (template)'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.api_routes r
    JOIN public.api_route_packs p ON p.id = r.pack_id
    WHERE p.name = 'logestechs_v2_mirror'
      AND upper(r.method) = 'GET'
      AND r.path_template = '/api/guests/{companyId}/packages/tracking'
      AND COALESCE((r.policy #>> '{postprocess,enabled}')::BOOLEAN, FALSE) = FALSE
  ),
  'tracking route has postprocess disabled'
);

SELECT * FROM finish();

ROLLBACK;

