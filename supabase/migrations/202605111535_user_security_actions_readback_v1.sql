-- Console V2 user security action readback.
-- Purpose:
--   Users drawer lifecycle actions must show backend-backed evidence in the
--   same app context after mutation success, without requiring a browser
--   reload or broad raw decision-log access.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605111535_user_security_actions_readback_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_list_user_security_actions_v1(
  p_target_user_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_target_org UUID;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_rows JSONB := '[]'::jsonb;
  v_total BIGINT := 0;
BEGIN
  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_list_user_security_actions_v1 requires target user id'
      USING ERRCODE = '23502';
  END IF;

  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  SELECT u.organization_id
    INTO v_target_org
    FROM public.users u
   WHERE u.id = p_target_user_id;

  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'ui_list_user_security_actions_v1 user % not found', p_target_user_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('users.read', v_scope_type, v_scope_id);

  IF NOT public.is_platform_user()
     AND COALESCE(v_scope_id, public.current_user_org_id()) IS DISTINCT FROM v_target_org THEN
    RAISE EXCEPTION 'ui_list_user_security_actions_v1 target user % outside tenant scope', p_target_user_id
      USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*)
    INTO v_total
    FROM public.decision_log dl
   WHERE dl.organization_id = v_target_org
     AND dl.resource_type = 'user'
     AND dl.resource_id = p_target_user_id
     AND dl.decision_point IN (
       'grant_user_role_v1',
       'revoke_user_role_v1',
       'suspend_user_v1',
       'reactivate_user_v1',
       'force_password_reset_v1'
     );

  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.timestamp DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        dl.id,
        dl.organization_id,
        dl.timestamp,
        dl.decision_category,
        dl.decision_point,
        dl.decision_outcome,
        dl.decision_reason,
        dl.decision_inputs,
        dl.resource_type,
        dl.resource_id,
        dl.correlation_id,
        dl.settings_resolution_id,
        dl.performed_by_system,
        dl.decision_inputs->>'password_reset_intent_id' AS password_reset_intent_id,
        dl.decision_inputs->>'role_key' AS role_key,
        dl.decision_inputs->>'reason' AS action_reason
      FROM public.decision_log dl
      WHERE dl.organization_id = v_target_org
        AND dl.resource_type = 'user'
        AND dl.resource_id = p_target_user_id
        AND dl.decision_point IN (
          'grant_user_role_v1',
          'revoke_user_role_v1',
          'suspend_user_v1',
          'reactivate_user_v1',
          'force_password_reset_v1'
        )
      ORDER BY dl.timestamp DESC
      LIMIT v_limit
    ) AS row_data;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'limit', v_limit,
    'offset', 0,
    'page', 0,
    'page_size', v_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_list_user_security_actions_v1(
  p_target_user_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_list_user_security_actions_v1($1, $2);
$$;

REVOKE ALL ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER)
  IS 'Console V2 backend-backed user drawer security-action readback. Returns scoped user lifecycle decision evidence for same-context no-reload UI confirmation.';
COMMENT ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER)
  IS 'API-schema wrapper for Console V2 user security-action readback.';

SELECT pg_advisory_unlock(hashtext('202605111535_user_security_actions_readback_v1'));
COMMIT;
