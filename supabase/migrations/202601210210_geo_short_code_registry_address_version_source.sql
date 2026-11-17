-- Migration: Short-code registry uses short_code_reverse address_version_source
-- Purpose:
--   - Ensure short-code registry hydration wins address_versions resolution for normalized_line1.
--   - Fix CI regression where normalized_line1 stayed as the short code (e.g. ABCD1234).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-21
BEGIN;
SET search_path TO public, workflow_handlers, extensions, pg_temp;

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

    -- Ensure address versioning projects hydrated normalized_line1 from this step
    -- (policy prioritizes short_code_reverse above user_input/legacy for normalized_line1).
    BEGIN
        PERFORM set_config('app.address_version_source', 'short_code_reverse', TRUE);
        v_response := workflow_handlers.execute_geo_short_code_registry_v1_base(
            p_step,
            p_run,
            p_operation_result
        );
    EXCEPTION
        WHEN OTHERS THEN
            PERFORM set_config('app.address_version_source', '', TRUE);
            RAISE;
    END;
    PERFORM set_config('app.address_version_source', '', TRUE);

    IF v_response.context_patch IS NOT NULL
       AND jsonb_typeof(v_response.context_patch) = 'object'
       AND v_response.context_patch->'geocoding' IS NOT NULL
       AND jsonb_typeof(v_response.context_patch->'geocoding') = 'object'
       AND (v_response.context_patch->'geocoding' ? 'reverse_geocode') THEN
        v_response.context_patch := jsonb_set(
            v_response.context_patch,
            '{geocoding}',
            (v_response.context_patch->'geocoding') - 'successful',
            true
        );
    END IF;

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

ALTER FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(
    public.workflow_run_steps,
    public.workflow_runs,
    JSONB
)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_geo_short_code_registry_v1(
    public.workflow_run_steps,
    public.workflow_runs,
    JSONB
)
  IS 'Short-code registry lookup (SSOT) with ISO2 country gate; ensures address_versions uses short_code_reverse source for hydrated fields so placeholders do not win.';

COMMIT;
