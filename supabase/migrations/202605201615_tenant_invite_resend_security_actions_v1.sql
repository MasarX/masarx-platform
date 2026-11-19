-- Console V2 Users: expose tenant invite / invite-resend decisions in the
-- same drawer security action readback stream used by lifecycle actions.

CREATE OR REPLACE FUNCTION public.tenant_user_invite_resend_assert_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_actor_user_id UUID := CASE
    WHEN public.request_role_is_service_v1() THEN COALESCE(NULLIF(p_args->>'actor_user_id', '')::uuid, auth.uid())
    ELSE auth.uid()
  END;
  v_target_org_id UUID := NULLIF(p_args->>'organization_id', '')::uuid;
  v_target_user_id UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_email TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'email', '')), ''));
  v_actor_org_id UUID;
  v_target_org UUID;
  v_target_email TEXT;
  v_target_status TEXT;
  v_role_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'role_key', '')), ''));
  v_status_is_invited BOOLEAN := FALSE;
  v_has_active_assignment BOOLEAN := FALSE;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 requires actor_user_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 requires target_user_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT u.organization_id INTO v_actor_org_id
    FROM public.users u
   WHERE u.id = v_actor_user_id;

  IF v_actor_org_id IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 actor user % not found', v_actor_user_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_service THEN
    PERFORM public.assert_capability_v1('users.manage');
  END IF;

  SELECT u.organization_id, lower(u.email), u.status
    INTO v_target_org, v_target_email, v_target_status
    FROM public.users u
   WHERE u.id = v_target_user_id;

  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 target user % not found', v_target_user_id
      USING ERRCODE = '23503';
  END IF;

  v_target_org_id := COALESCE(v_target_org_id, v_actor_org_id);

  IF v_target_org IS DISTINCT FROM v_target_org_id
     OR (v_actor_org_id IS NOT NULL AND v_target_org_id <> v_actor_org_id AND NOT public.is_platform_user()) THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 target user % outside tenant scope', v_target_user_id
      USING ERRCODE = '42501';
  END IF;

  IF v_email IS NOT NULL AND v_email <> v_target_email THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 email does not match target user'
      USING ERRCODE = '23514';
  END IF;

  IF v_role_key IS NULL THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 requires role_key'
      USING ERRCODE = '23502';
  END IF;

  SELECT COALESCE((lv.metadata->>'is_invited')::boolean, FALSE)
    INTO v_status_is_invited
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'user_status'
     AND lv.value = v_target_status
   LIMIT 1;

  IF NOT COALESCE(v_status_is_invited, FALSE) THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 target user % is not invited', v_target_user_id
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.rbac_user_role_assignments a
      JOIN public.rbac_roles r ON r.id = a.role_id
     WHERE a.organization_id = v_target_org
       AND a.user_id = v_target_user_id
       AND a.revoked_at IS NULL
       AND r.key = v_role_key
  ) INTO v_has_active_assignment;

  IF NOT COALESCE(v_has_active_assignment, FALSE) THEN
    RAISE EXCEPTION 'tenant_user_invite_resend_assert_v1 role_key % is not actively assigned to target user %', v_role_key, v_target_user_id
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'actor_user_id', v_actor_user_id,
    'target_user_id', v_target_user_id,
    'organization_id', v_target_org,
    'email', v_target_email,
    'role_key', v_role_key,
    'status', v_target_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_user_invite_resend_assert_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_user_invite_resend_assert_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.tenant_user_invite_resend_assert_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.tenant_user_invite_resend_assert_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE SQL
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.tenant_user_invite_resend_assert_v1(COALESCE($1, '{}'::jsonb));
$$;

REVOKE ALL ON FUNCTION api.tenant_user_invite_resend_assert_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.tenant_user_invite_resend_assert_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.tenant_user_invite_resend_assert_v1(JSONB) TO authenticated, service_role;

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
       'force_password_reset_v1',
       'tenant_user_invite_apply_v1'
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
        dl.decision_inputs->>'reason' AS action_reason,
        dl.decision_inputs->>'email' AS invite_email,
        dl.decision_inputs->>'invite_email_sent' AS invite_email_sent,
        dl.decision_inputs->>'send_invite_email_requested' AS send_invite_email_requested
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
          'force_password_reset_v1',
          'tenant_user_invite_apply_v1'
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

GRANT EXECUTE ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_list_user_security_actions_v1(
  p_target_user_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE SQL
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_list_user_security_actions_v1($1, $2);
$$;

GRANT EXECUTE ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER)
  IS 'Console V2 Users drawer readback: returns backend decision evidence for user lifecycle, session, role, password reset, and invite resend actions.';

COMMENT ON FUNCTION public.tenant_user_invite_resend_assert_v1(JSONB)
  IS 'Console V2 Users hosted invite resend guard: same-tenant target must still be in a row-driven invited status before Auth delivery is attempted.';
