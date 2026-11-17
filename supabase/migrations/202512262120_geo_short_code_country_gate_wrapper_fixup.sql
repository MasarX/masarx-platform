-- Migration: Short-code lookup wrapper fixup (re-apply after migration version collisions)
-- Purpose:
--   - Ensure workflow_handlers.execute_geo_short_code_registry_v1 persists ISO2 country gate
--     when addresses.country is missing/invalid, even if the original wrapper migration was skipped.
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - ZERO HARD CODING (policy-driven) - workflow-driven - SSOT.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- If the wrapper base function does not exist yet (e.g., migration version collision skipped the wrapper),
-- rename the current implementation into *_base so we can install/update the wrapper safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'workflow_handlers'
      AND p.proname = 'execute_geo_short_code_registry_v1_base'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'workflow_handlers'
        AND p.proname = 'execute_geo_short_code_registry_v1'
    ) THEN
      EXECUTE 'ALTER FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
               RENAME TO execute_geo_short_code_registry_v1_base';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'workflow_handlers'
      AND p.proname = 'execute_geo_short_code_registry_v1_base'
  ) THEN
    RAISE EXCEPTION 'execute_geo_short_code_registry_v1_base is missing; cannot apply short-code country gate wrapper';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_response public.workflow_handler_response;
    v_ctx RECORD;
    v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
    v_plugin JSONB := workflow_handlers.geocoding_get_plugin(v_policy, 'short_code');
    v_params JSONB := COALESCE(v_plugin->'params', '{}'::jsonb);
    v_country_gate TEXT := upper(NULLIF(v_params->>'country', ''));
    v_code_value TEXT := NULL;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

    v_response := workflow_handlers.execute_geo_short_code_registry_v1_base(
        p_step,
        p_run,
        p_operation_result
    );

    -- Only act when the plugin actually matched a candidate code (hit or miss).
    v_code_value := upper(NULLIF(COALESCE(v_response.operation_result->>'code_value', ''), ''));
    IF v_code_value IS NULL THEN
        RETURN v_response;
    END IF;

    -- Only persist ISO2 country codes (policy-driven gate).
    IF v_country_gate IS NULL OR length(v_country_gate) <> 2 THEN
        RETURN v_response;
    END IF;

    SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);
    IF v_ctx.address_id IS NULL OR v_ctx.client_id IS NULL THEN
        RETURN v_response;
    END IF;

    UPDATE public.addresses a
    SET country = v_country_gate,
        updated_at = now()
    WHERE a.id = v_ctx.address_id
      AND a.client_id = v_ctx.client_id
      AND (a.country IS NULL OR a.country = '' OR length(a.country) <> 2);

    RETURN v_response;
END;
$$;

ALTER FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Short-code registry lookup (SSOT) with a wrapper that persists ISO2 country gate (matching_plugins.short_code.params.country) onto addresses.country when missing/invalid, keeping cache keys stable and avoiding ISO3 drift.';

COMMIT;

