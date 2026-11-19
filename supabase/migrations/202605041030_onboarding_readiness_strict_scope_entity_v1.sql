-- Purpose: make Console/Portal onboarding readiness prove that scoped
-- onboarding targets exist before reporting default/workflow/plugin health.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041030_onboarding_readiness_strict_scope_entity_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.onboarding_readiness_scope_entity_status_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_entity_table REGCLASS;
  v_id_column TEXT;
  v_exists BOOLEAN := TRUE;
BEGIN
  IF p_scope_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', v_scope_type,
      'scope_id', NULL
    );
  END IF;

  SELECT r.entity_table, r.id_column
    INTO v_entity_table, v_id_column
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_entity_table IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id
    );
  END IF;

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)',
    v_entity_table,
    v_id_column
  )
    INTO v_exists
    USING p_scope_id;

  RETURN jsonb_build_object(
    'ok', COALESCE(v_exists, FALSE),
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'entity_table', v_entity_table::text,
    'id_column', v_id_column
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_get_onboarding_readiness_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope RECORD;
  v_entity_status JSONB;
  v_generated_at TIMESTAMPTZ := now();
  v_missing_finding JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_onboarding_readiness_v1 requires authenticated user';
  END IF;

  SELECT *
    INTO v_scope
    FROM public.resolve_settings_scope_context_v1(p_scope_type, p_scope_id)
   LIMIT 1;

  IF NOT (
    public.user_has_capability_v1('settings.read', v_scope.scope_type, v_scope.scope_id)
    OR public.user_has_capability_v1('workflow_runs.read', v_scope.scope_type, v_scope.scope_id)
    OR public.user_has_capability_v1('integration_plugins.read', v_scope.scope_type, v_scope.scope_id)
  ) THEN
    RAISE EXCEPTION
      'ui_get_onboarding_readiness_v1 requires settings.read, workflow_runs.read, or integration_plugins.read capability'
      USING ERRCODE = '42501';
  END IF;

  v_entity_status := public.onboarding_readiness_scope_entity_status_v1(v_scope.scope_type, v_scope.scope_id);

  IF COALESCE((v_entity_status->>'ok')::BOOLEAN, FALSE) IS FALSE THEN
    v_missing_finding := jsonb_build_object(
      'severity', 'blocking',
      'component', 'scope',
      'code', 'missing_scope_entity',
      'scope_type', v_scope.scope_type,
      'scope_id', v_scope.scope_id,
      'entity_table', v_entity_status->>'entity_table',
      'message', format(
        'Readiness scope %s/%s does not resolve to an existing canonical entity.',
        v_scope.scope_type,
        COALESCE(v_scope.scope_id::text, 'global')
      )
    );

    RETURN jsonb_build_object(
      'scope_type', v_scope.scope_type,
      'scope_id', v_scope.scope_id,
      'organization_id', NULL,
      'generated_at', v_generated_at,
      'overall_status', 'blocked',
      'healthy', FALSE,
      'settings_defaults', jsonb_build_object(
        'status', 'blocked',
        'healthy', FALSE,
        'required_count', 0,
        'present_count', 0,
        'missing_categories', '[]'::jsonb
      ),
      'workflow_bindings', jsonb_build_object(
        'status', 'blocked',
        'healthy', FALSE,
        'baseline_profile', NULL,
        'required_count', 0,
        'present_count', 0,
        'missing_stages', '[]'::jsonb
      ),
      'integration_plugins', jsonb_build_object(
        'status', 'blocked',
        'healthy', FALSE,
        'baseline_profile', NULL,
        'required_count', 0,
        'healthy_count', 0,
        'pending_credentials_count', 0,
        'blocking_count', 1,
        'items', '[]'::jsonb
      ),
      'blocking_findings', jsonb_build_array(v_missing_finding)
    );
  END IF;

  RETURN public.onboarding_readiness_snapshot_v1(v_scope.scope_type, v_scope.scope_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.onboarding_readiness_scope_entity_status_v1(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.onboarding_readiness_scope_entity_status_v1(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605041030_onboarding_readiness_strict_scope_entity_v1'));

COMMIT;
