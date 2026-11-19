-- Console V2 user session revoke evidence hardening.
-- Purpose:
--   Session revoke is a user security action. The same Users drawer must be
--   able to read the backend decision evidence after revoke_session_v1 succeeds,
--   and the canonical RPC must fail closed when no operator reason is supplied.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605200930_user_session_revoke_security_evidence_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.revoke_session_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID;
  v_target_user_id UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_session_id TEXT := NULLIF(btrim(COALESCE(p_args->>'session_id', '')), '');
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'revoke_session_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.manage');

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'revoke_session_v1 requires target_user_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'revoke_session_v1 requires reason'
      USING ERRCODE = '23502';
  END IF;

  SELECT organization_id INTO v_target_org FROM public.users WHERE id = v_target_user_id;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'revoke_session_v1 target user % not found', v_target_user_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'revoke_session_v1 target user % outside tenant scope', v_target_user_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.revocation_audit (
    organization_id, target_user_id, session_id, reason,
    revoked_by, status, correlation_id, decision_log_id
  ) VALUES (
    v_target_org, v_target_user_id, v_session_id, v_reason,
    v_user_id, 'pending', v_correlation_id::text, v_decision_id
  )
  RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org, 'sessions.revoke', 'user', v_target_user_id,
    'revoke_session_v1', 'pending',
    jsonb_strip_nulls(jsonb_build_object('session_id', v_session_id, 'reason', v_reason)),
    'revoke_session_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'session.revocation_requested', 'user', v_target_user_id,
    jsonb_strip_nulls(jsonb_build_object(
      'revocation_audit_id', v_resource_id,
      'session_id', v_session_id,
      'reason', v_reason
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'revocation_audit_id', v_resource_id,
    'target_user_id', v_target_user_id,
    'status', 'pending',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_session_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_session_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_session_v1(jsonb) TO service_role;

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
       'revoke_session_v1',
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
        dl.decision_inputs->>'session_id' AS session_id,
        dl.decision_inputs->>'reason' AS action_reason
      FROM public.decision_log dl
      WHERE dl.organization_id = v_target_org
        AND dl.resource_type = 'user'
        AND dl.resource_id = p_target_user_id
        AND dl.decision_point IN (
          'grant_user_role_v1',
          'revoke_user_role_v1',
          'revoke_session_v1',
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

COMMENT ON FUNCTION public.revoke_session_v1(jsonb)
  IS 'Canonical write RPC: enqueue revocation intent in revocation_audit and decision_log. Requires operator reason. Capability: users.manage.';
COMMENT ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER)
  IS 'Console V2 backend-backed user drawer security-action readback, including user session revoke evidence.';
COMMENT ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER)
  IS 'API-schema wrapper for Console V2 user security-action readback.';

SELECT pg_advisory_unlock(hashtext('202605200930_user_session_revoke_security_evidence_v1'));
COMMIT;
