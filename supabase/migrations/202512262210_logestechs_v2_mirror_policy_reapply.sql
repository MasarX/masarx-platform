-- Plan: PLAN-202512-api-gateway-logestechs-per-client-accounts / Step: S95
-- Migration: Re-apply Logestechs V2 mirror provider_account + company-id header policy (drift-safe)
-- Purpose:
--   - Some shared environments may apply route seed migrations out of order (e.g., `--include-all`),
--     which can leave later-seeded Logestechs mirror routes without:
--       - `policy.provider_account` (ladder-driven account binding)
--       - `policy.headers.overrides.company-id` (required by Logestechs)
--   - Re-apply the policy idempotently across the entire `logestechs_v2_mirror` pack so the system
--     remains deterministic and enterprise-safe.
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
    RAISE NOTICE 'logestechs_v2_mirror pack not found; skipping policy re-apply';
    RETURN;
  END IF;

  UPDATE public.api_routes
  SET policy = jsonb_set(
      jsonb_set(
        COALESCE(policy, '{}'::jsonb),
        '{provider_account}',
        (
          CASE
            WHEN jsonb_typeof(policy->'provider_account') = 'object' THEN COALESCE(policy->'provider_account', '{}'::jsonb)
            ELSE '{}'::jsonb
          END
        ) || jsonb_build_object(
          'category', 'logestechs_v2_account',
          'required', TRUE,
          'require_company_id', TRUE,
          'require_auth_config_id', TRUE
        ),
        TRUE
      ),
      '{headers}',
      (
        CASE
          WHEN jsonb_typeof(policy->'headers') = 'object' THEN COALESCE(policy->'headers', '{}'::jsonb)
          ELSE '{}'::jsonb
        END
      ) || jsonb_build_object(
        'defaults',
        CASE
          WHEN jsonb_typeof(policy #> '{headers,defaults}') = 'object' THEN (policy #> '{headers,defaults}') - 'company-id'
          ELSE '{}'::jsonb
        END,
        'overrides',
        (
          CASE
            WHEN jsonb_typeof(policy #> '{headers,overrides}') = 'object' THEN COALESCE(policy #> '{headers,overrides}', '{}'::jsonb)
            ELSE '{}'::jsonb
          END
        ) || jsonb_build_object('company-id', '{{provider_account.company_id}}')
      ),
      TRUE
    ),
    updated_at = now()
  WHERE pack_id = v_pack_id
    AND enabled = TRUE;
END;
$$;

COMMIT;

