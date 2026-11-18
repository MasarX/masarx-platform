-- Migration: Mobile V2 active-role decision-log category alignment
-- Date: 2026-05-27
-- Scope: auth_set_active_role_v1 must audit through the existing
-- decision_category lookup value `fieldops_role_set`; the previous
-- literal `auth.set_active_role` is not registered in current lookup_values
-- and can make backend role switching fail after the role is persisted.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605271115_mobile_v2_active_role_decision_category'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.auth_set_active_role_v1(p_role_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org UUID;
  v_normalized_role TEXT;
  v_assignment_count INT;
  v_capability_keys TEXT[];
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_existing_role TEXT;
  v_outcome TEXT;
  v_switched_at TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_set_active_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_normalized_role := lower(btrim(COALESCE(p_role_key, '')));
  IF v_normalized_role = '' THEN
    RAISE EXCEPTION 'auth_set_active_role_v1: role_key required'
      USING ERRCODE = '22023';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'auth_set_active_role_v1: caller has no organization context'
      USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*)
    INTO v_assignment_count
    FROM public.rbac_user_role_assignments ura
    JOIN public.rbac_roles r ON r.id = ura.role_id
   WHERE ura.user_id = v_user_id
     AND ura.organization_id = v_caller_org
     AND ura.revoked_at IS NULL
     AND lower(r.key) = v_normalized_role;

  IF v_assignment_count = 0 THEN
    PERFORM public.log_decision(
      p_organization_id := v_caller_org,
      p_decision_category := 'fieldops_role_set',
      p_resource_type := 'mobile_v2_active_role',
      p_resource_id := v_user_id,
      p_decision_point := 'auth_set_active_role_v1',
      p_decision_outcome := 'denied_role_not_assigned',
      p_performed_by_system := 'auth_set_active_role_v1',
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object(
        'requested_role', v_normalized_role,
        'caller_user_id', v_user_id
      ),
      p_decision_reason := 'requested role is not in caller active rbac assignments'
    );
    RAISE EXCEPTION 'auth_set_active_role_v1: role % not assigned to caller', v_normalized_role
      USING ERRCODE = '42501';
  END IF;

  SELECT role_key INTO v_existing_role
    FROM public.mobile_v2_active_role
   WHERE user_id = v_user_id;

  BEGIN
    SELECT ARRAY_AGG(DISTINCT cap)
      INTO v_capability_keys
      FROM (
        SELECT jsonb_array_elements_text(
                 COALESCE(role_def->'capability_keys', '[]'::jsonb)
               ) AS cap
          FROM public.settings s
          JOIN public.settings_versions sv
            ON sv.id = s.settings_version_id,
               jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role_def
         WHERE s.category = 'access_control_policy'
           AND s.scope_type IN ('global', 'tenant')
           AND (s.scope_id IS NULL OR s.scope_id = v_caller_org)
           AND lower(role_def->>'key') = v_normalized_role
      ) caps;
  EXCEPTION WHEN OTHERS THEN
    v_capability_keys := ARRAY[]::TEXT[];
  END;

  v_capability_keys := COALESCE(v_capability_keys, ARRAY[]::TEXT[]);

  INSERT INTO public.mobile_v2_active_role (
    user_id, organization_id, role_key, switched_at
  ) VALUES (
    v_user_id, v_caller_org, v_normalized_role, now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      role_key = EXCLUDED.role_key,
      switched_at = CASE
        WHEN public.mobile_v2_active_role.role_key = EXCLUDED.role_key
          THEN public.mobile_v2_active_role.switched_at
        ELSE EXCLUDED.switched_at
      END
  RETURNING switched_at INTO v_switched_at;

  IF v_existing_role IS NULL THEN
    v_outcome := 'role_set';
  ELSIF v_existing_role = v_normalized_role THEN
    v_outcome := 'role_unchanged';
  ELSE
    v_outcome := 'role_switched';
  END IF;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_caller_org,
    p_decision_category := 'fieldops_role_set',
    p_resource_type := 'mobile_v2_active_role',
    p_resource_id := v_user_id,
    p_decision_point := 'auth_set_active_role_v1',
    p_decision_outcome := v_outcome,
    p_performed_by_system := 'auth_set_active_role_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object(
      'previous_role', v_existing_role,
      'requested_role', v_normalized_role,
      'capability_count', COALESCE(array_length(v_capability_keys, 1), 0)
    ),
    p_decision_reason := 'mobile-v2 drawer role switch'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'active_role', v_normalized_role,
    'previous_role', v_existing_role,
    'organization_id', v_caller_org,
    'capability_keys', to_jsonb(v_capability_keys),
    'switched_at', v_switched_at,
    'correlation_id', v_correlation_id,
    'decision_log_id', v_decision_log_id,
    'outcome', v_outcome
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auth_set_active_role_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_set_active_role_v1(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.auth_set_active_role_v1(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.auth_set_active_role_v1(TEXT) IS
  'Mobile V2 drawer role switch. Validates the requested role is in caller active rbac_user_role_assignments, persists the selection in mobile_v2_active_role, and audit-logs to decision_log with fieldops_role_set.';

SELECT pg_advisory_unlock(hashtext('202605271115_mobile_v2_active_role_decision_category'));
COMMIT;
