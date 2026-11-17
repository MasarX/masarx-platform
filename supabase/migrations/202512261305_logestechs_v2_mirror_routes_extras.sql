-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Seed additional Logestechs V2 mirror routes (API gateway)
-- Purpose:
--   - Extend the Logestechs V2 mirror pack with endpoints present in the Postman collection JSON:
--     - GET /api/addresses/villages
--     - GET /api/guests/packages/status
--     - GET /api/guests/companies/info-by-domain
--     - GET /api/guests/{companyId}/packages/tracking
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_pack_id UUID;
  v_provider_id UUID;
BEGIN
  SELECT id INTO v_provider_id
  FROM public.providers
  WHERE name = 'logestechs_3pl'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE NOTICE 'logestechs_3pl provider not found; skipping Logestechs V2 mirror extra routes seed';
    RETURN;
  END IF;

  INSERT INTO public.api_route_packs (name, description, enabled, created_at, updated_at)
  VALUES (
    'logestechs_v2_mirror',
    'Mirror Logestechs V2 endpoints (client-facing compatibility pack).',
    TRUE,
    now(),
    now()
  )
  ON CONFLICT (name) DO UPDATE
    SET description = EXCLUDED.description,
        enabled = EXCLUDED.enabled,
        updated_at = now()
  RETURNING id INTO v_pack_id;

  -- Get Villages/Districts (Logestechs V2)
  INSERT INTO public.api_routes (
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
    policy,
    created_at,
    updated_at
  )
  VALUES (
    v_pack_id,
    'logestechs_v2_get_villages',
    TRUE,
    'GET',
    '/api/addresses/villages',
    'global',
    NULL,
    v_provider_id,
    'GET',
    '/api/addresses/villages',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30)
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = EXCLUDED.policy,
        enabled = EXCLUDED.enabled,
        route_name = EXCLUDED.route_name,
        updated_at = now();

  -- Get package status (Logestechs V2)
  INSERT INTO public.api_routes (
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
    policy,
    created_at,
    updated_at
  )
  VALUES (
    v_pack_id,
    'logestechs_v2_get_package_status',
    TRUE,
    'GET',
    '/api/guests/packages/status',
    'global',
    NULL,
    v_provider_id,
    'GET',
    '/api/guests/packages/status',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30)
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = EXCLUDED.policy,
        enabled = EXCLUDED.enabled,
        route_name = EXCLUDED.route_name,
        updated_at = now();

  -- Get company info by domain (Logestechs V2)
  INSERT INTO public.api_routes (
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
    policy,
    created_at,
    updated_at
  )
  VALUES (
    v_pack_id,
    'logestechs_v2_get_company_info_by_domain',
    TRUE,
    'GET',
    '/api/guests/companies/info-by-domain',
    'global',
    NULL,
    v_provider_id,
    'GET',
    '/api/guests/companies/info-by-domain',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30)
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = EXCLUDED.policy,
        enabled = EXCLUDED.enabled,
        route_name = EXCLUDED.route_name,
        updated_at = now();

  -- Get shipment tracking/history (Logestechs V2)
  INSERT INTO public.api_routes (
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
    policy,
    created_at,
    updated_at
  )
  VALUES (
    v_pack_id,
    'logestechs_v2_get_packages_tracking',
    TRUE,
    'GET',
    '/api/guests/{companyId}/packages/tracking',
    'global',
    NULL,
    v_provider_id,
    'GET',
    '/api/guests/{companyId}/packages/tracking',
    jsonb_build_object(
      'delivery', jsonb_build_object('mode', 'proxy', 'timeout_seconds', 30)
    ),
    now(),
    now()
  )
  ON CONFLICT (method, path_template, scope_type, scope_id) DO UPDATE
    SET provider_id = EXCLUDED.provider_id,
        upstream_method = EXCLUDED.upstream_method,
        upstream_path_template = EXCLUDED.upstream_path_template,
        policy = EXCLUDED.policy,
        enabled = EXCLUDED.enabled,
        route_name = EXCLUDED.route_name,
        updated_at = now();
END;
$$;

COMMIT;

