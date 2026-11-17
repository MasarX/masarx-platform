-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Logestechs V2 mirror defaults (company-id header)
-- Purpose:
--   - Ensure Logestechs V2 mirror routes can operate with base-URL-only client changes by defaulting required provider header(s).
--   - Keep behavior row-driven via api_routes.policy.headers.defaults (no code hardcoding).
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_pack_id UUID;
BEGIN
  SELECT id INTO v_pack_id
  FROM public.api_route_packs
  WHERE name = 'logestechs_v2_mirror'
  LIMIT 1;

  IF v_pack_id IS NULL THEN
    RAISE NOTICE 'logestechs_v2_mirror pack not found; skipping company-id default update';
    RETURN;
  END IF;

  UPDATE public.api_routes
  SET policy = jsonb_set(
    COALESCE(policy, '{}'::jsonb),
    '{headers,defaults}',
    COALESCE(policy #> '{headers,defaults}', '{}'::jsonb) || jsonb_build_object('company-id', '362'),
    TRUE
  ),
  updated_at = now()
  WHERE pack_id = v_pack_id
    AND enabled = TRUE;
END;
$$;

COMMIT;

