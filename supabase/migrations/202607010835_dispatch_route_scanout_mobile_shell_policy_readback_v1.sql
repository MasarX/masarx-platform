-- Spec: Dispatch route scan-out local readiness
-- Migration: Mobile shell policy aggregate readback for runtime proof
-- Date: 2026-07-01
--
-- Goal:
--   - Provide the browser/proof runner with a stable Mobile V2 shell policy
--     readback contract while preserving the canonical category-specific,
--     row-driven policy resolvers used by FieldOps.

BEGIN;
SELECT pg_advisory_lock(hashtext('202607010835_dispatch_route_scanout_mobile_shell_policy_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_mobile_shell_policy(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_active_role TEXT := COALESCE(NULLIF(BTRIM(p_active_role), ''), 'driver');
  v_caller_org UUID := public.current_user_org_id();
  v_rollout RECORD;
  v_resolver JSONB;
  v_category TEXT;
  v_function_name TEXT;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_row_scope_type TEXT;
  v_row_scope_id UUID;
  v_row_value JSONB;
  v_row_version INT;
  v_row_scope_path JSONB;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_scope_path JSONB := '[]'::jsonb;
  v_version INT;
  v_policies JSONB := '{}'::jsonb;
  v_missing_categories TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF jsonb_typeof(v_context) <> 'object' OR auth.uid() IS NULL THEN
    v_context := '{}'::jsonb;
  END IF;
  IF v_caller_org IS NOT NULL THEN
    v_context := jsonb_build_object('organization_id', v_caller_org) || v_context;
  END IF;

  SELECT * INTO v_rollout
  FROM public.resolve_mobile_shell_policy_row(jsonb_strip_nulls(
    jsonb_build_object('organization_id', v_caller_org)
  ));

  FOR v_resolver IN
    SELECT value
    FROM jsonb_array_elements(
      jsonb_build_array(
        jsonb_build_object('category', 'mobile_visibility_policy', 'function', 'resolve_mobile_visibility_policy'),
        jsonb_build_object('category', 'mobile_diagnostics_policy', 'function', 'resolve_mobile_diagnostics_policy'),
        jsonb_build_object('category', 'device_policy', 'function', 'resolve_device_policy'),
        jsonb_build_object('category', 'navigation_policy', 'function', 'resolve_navigation_policy'),
        jsonb_build_object('category', 'map_policy', 'function', 'resolve_map_policy'),
        jsonb_build_object('category', 'communication_policy', 'function', 'resolve_communication_policy'),
        jsonb_build_object('category', 'address_policy', 'function', 'resolve_address_policy'),
        jsonb_build_object('category', 'driver_safety_policy', 'function', 'resolve_driver_safety_policy'),
        jsonb_build_object('category', 'ux_safety_policy', 'function', 'resolve_ux_safety_policy'),
        jsonb_build_object('category', 'mobile_push_policy', 'function', 'resolve_mobile_push_policy'),
        jsonb_build_object('category', 'mobile_attestation_policy', 'function', 'resolve_mobile_attestation_policy'),
        jsonb_build_object('category', 'mobile_sync_policy', 'function', 'resolve_mobile_sync_policy')
      )
    )
  LOOP
    v_category := v_resolver->>'category';
    v_function_name := v_resolver->>'function';
    v_settings_id := NULL;
    v_settings_version_id := NULL;
    v_row_scope_type := NULL;
    v_row_scope_id := NULL;
    v_row_value := NULL;
    v_row_version := NULL;
    v_row_scope_path := NULL;

    EXECUTE format(
      'SELECT settings_id, settings_version_id, scope_type, scope_id, value, version, scope_path FROM public.%I($1) LIMIT 1',
      v_function_name
    )
    INTO v_settings_id, v_settings_version_id, v_row_scope_type, v_row_scope_id, v_row_value, v_row_version, v_row_scope_path
    USING v_context;

    IF v_settings_id IS NULL THEN
      v_missing_categories := array_append(v_missing_categories, v_category);
    ELSE
      v_policies := v_policies || jsonb_build_object(
        v_category,
        jsonb_build_object(
          'settings_id', v_settings_id,
          'settings_version_id', v_settings_version_id,
          'scope_type', v_row_scope_type,
          'scope_id', v_row_scope_id,
          'value', COALESCE(v_row_value, '{}'::jsonb),
          'version', v_row_version,
          'scope_path', COALESCE(v_row_scope_path, '[]'::jsonb)
        )
      );

      IF v_scope_type IS NULL THEN
        v_scope_type := v_row_scope_type;
        v_scope_id := v_row_scope_id;
        v_scope_path := COALESCE(v_row_scope_path, '[]'::jsonb);
        v_version := v_row_version;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'active_role', v_active_role,
    'v2_enabled', COALESCE(
      v_caller_org IS NOT NULL AND v_rollout.scope_type = 'tenant'
        AND v_rollout.scope_id = v_caller_org
        AND v_rollout.value->'v2_enabled' = 'true'::jsonb
        AND cardinality(v_missing_categories) = 0, FALSE
    ),
    'rollout_cohort', COALESCE(NULLIF(v_rollout.value->>'rollout_cohort', ''), 'default'),
    'resolved_at', now(),
    'scope_type', COALESCE(v_scope_type, 'unresolved'),
    'scope_id', v_scope_id,
    'scope_path', COALESCE(v_scope_path, '[]'::jsonb),
    'version', v_version,
    'missing_categories', to_jsonb(v_missing_categories),
    'policies', v_policies
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB)
  IS 'Resolve shell policy readiness and require the authenticated tenant rollout opt-in to enable Mobile V2.';
REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202607010835_dispatch_route_scanout_mobile_shell_policy_readback_v1'));
COMMIT;
