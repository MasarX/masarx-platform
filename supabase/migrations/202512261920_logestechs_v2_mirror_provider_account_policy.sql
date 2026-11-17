-- Plan: PLAN-202512-api-gateway-logestechs-per-client-accounts / Step: S04
-- Migration: Logestechs V2 mirror provider account binding (policy-driven)
-- Purpose:
--   - Bind Logestechs mirror routes to the ladder-driven `logestechs_v2_account` settings category.
--   - Enforce `company-id` via policy.headers.overrides rendered from provider_account (no hardcoded header values).
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
    RAISE NOTICE 'logestechs_v2_mirror pack not found; skipping provider_account policy update';
    RETURN;
  END IF;

  -- Add provider_account binding + company-id override (rendered via {{provider_account.company_id}}).
  UPDATE public.api_routes
  SET policy = jsonb_set(
      jsonb_set(
        COALESCE(policy, '{}'::jsonb),
        '{provider_account}',
        jsonb_build_object(
          'category', 'logestechs_v2_account',
          'required', TRUE,
          'require_company_id', TRUE,
          'require_auth_config_id', TRUE
        ),
        TRUE
      ),
      '{headers,overrides}',
      COALESCE(policy #> '{headers,overrides}', '{}'::jsonb)
        || jsonb_build_object('company-id', '{{provider_account.company_id}}'),
      TRUE
    ),
    updated_at = now()
  WHERE pack_id = v_pack_id
    AND enabled = TRUE;

  -- Remove any hardcoded company-id defaults from earlier seeds (keep header behavior dynamic).
  UPDATE public.api_routes
  SET policy = jsonb_set(
      COALESCE(policy, '{}'::jsonb),
      '{headers,defaults}',
      COALESCE(policy #> '{headers,defaults}', '{}'::jsonb) - 'company-id',
      TRUE
    ),
    updated_at = now()
  WHERE pack_id = v_pack_id
    AND enabled = TRUE
    AND jsonb_typeof(policy #> '{headers,defaults}') = 'object'
    AND (policy #> '{headers,defaults}' ? 'company-id');
END;
$$;

COMMIT;

