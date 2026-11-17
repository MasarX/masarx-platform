-- Plan: PLAN-202601-workflow-logestechs-address-sync / Step: S01
-- Migration: Enable workflow-driven geocode-first for Logestechs V2 create shipment route
-- Date: 2026-01-09

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $do$
DECLARE
  v_pack_id UUID;
BEGIN
  SELECT id INTO v_pack_id
  FROM public.api_route_packs
  WHERE name = 'logestechs_v2_mirror'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_pack_id IS NULL THEN
    RAISE NOTICE 'logestechs_v2_mirror pack missing; skipping workflow enablement';
    RETURN;
  END IF;

  UPDATE public.api_routes r
  SET policy = public.jsonb_deep_merge(
        COALESCE(r.policy, '{}'::jsonb),
        jsonb_build_object(
          'delivery', jsonb_build_object(
            'mode', 'accepted_async',
            'status_code', 202,
            'headers', jsonb_build_object('content-type', 'application/json')
          ),
          'workflow', jsonb_build_object(
            'enabled', TRUE,
            'template_name', 'api_gateway_logestechs_v2_create_geocode_first_v1'
          ),
          -- Avoid double-geocoding: geocode-first happens before dispatch.
          'postprocess', jsonb_build_object(
            'geocoding', jsonb_build_object('enabled', FALSE)
          )
        )
      ),
      updated_at = now()
  WHERE r.pack_id = v_pack_id
    AND upper(r.method) = 'POST'
    AND r.path_template = '/api/ship/request/by-email'
    AND r.scope_type = 'global'
    AND r.enabled = TRUE;
END;
$do$;

COMMIT;
