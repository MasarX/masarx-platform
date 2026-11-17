-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Ensure Logestechs V2 mirror enforces company-id header (policy.headers.overrides)
-- Purpose:
--   - Prior migrations attempted to set `policy.headers.defaults/overrides` via jsonb_set on nested paths.
--   - jsonb_set does not create intermediate objects; when `policy.headers` is absent, nested updates are a no-op.
--   - Enforce `company-id` header via top-level `headers` merge, rendered from `provider_account.company_id`.
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
    RAISE NOTICE 'logestechs_v2_mirror pack not found; skipping company-id override fix';
    RETURN;
  END IF;

  UPDATE public.api_routes
  SET policy = jsonb_set(
      COALESCE(policy, '{}'::jsonb),
      '{headers}',
      COALESCE(policy->'headers', '{}'::jsonb)
        || jsonb_build_object(
          'defaults',
          CASE
            WHEN jsonb_typeof(policy #> '{headers,defaults}') = 'object' THEN (policy #> '{headers,defaults}') - 'company-id'
            ELSE '{}'::jsonb
          END,
          'overrides',
          COALESCE(policy #> '{headers,overrides}', '{}'::jsonb)
            || jsonb_build_object('company-id', '{{provider_account.company_id}}')
        ),
      TRUE
    ),
    updated_at = now()
  WHERE pack_id = v_pack_id
    AND enabled = TRUE;
END;
$$;

COMMIT;

