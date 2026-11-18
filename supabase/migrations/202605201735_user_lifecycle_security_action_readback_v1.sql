BEGIN;

SELECT pg_advisory_lock(hashtext('202605201735_user_lifecycle_security_action_readback_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.grant_user_role_v1(p_args jsonb)
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
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_role_key TEXT := NULLIF(btrim(COALESCE(p_args->>'role_key', '')), '');
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
  v_user_org UUID;
  v_role_id UUID;
  v_role_org UUID;
  v_assignment_id UUID;
  v_existing_id UUID;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'grant_user_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.manage');

  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'grant_user_role_v1 requires target_user_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_role_key IS NULL THEN
    RAISE EXCEPTION 'grant_user_role_v1 requires role_key'
      USING ERRCODE = '23502';
  END IF;

  SELECT u.organization_id INTO v_user_org
    FROM public.users u
   WHERE u.id = v_target_user;
  IF v_user_org IS NULL THEN
    RAISE EXCEPTION 'grant_user_role_v1 target user % not found', v_target_user
      USING ERRCODE = '23503';
  END IF;

  v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_user_org);
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'grant_user_role_v1 target user % outside tenant scope', v_target_user
      USING ERRCODE = '42501';
  END IF;
  IF v_user_org <> v_target_org THEN
    RAISE EXCEPTION 'grant_user_role_v1 organization mismatch (user %, target %)',
      v_user_org, v_target_org
      USING ERRCODE = '23514';
  END IF;

  SELECT r.id, r.organization_id INTO v_role_id, v_role_org
    FROM public.rbac_roles r
   WHERE r.organization_id = v_target_org
     AND r.key = v_role_key
   LIMIT 1;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'grant_user_role_v1 role_key % not found in org %', v_role_key, v_target_org
      USING ERRCODE = '23503';
  END IF;
  IF v_role_org <> v_target_org THEN
    RAISE EXCEPTION 'grant_user_role_v1 role/org mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT id INTO v_existing_id
    FROM public.rbac_user_role_assignments
   WHERE organization_id = v_target_org
     AND user_id = v_target_user
     AND role_id = v_role_id
     AND revoked_at IS NULL
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    v_assignment_id := v_existing_id;
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    INSERT INTO public.rbac_user_role_assignments (
      organization_id, user_id, role_id, assigned_by_user_id, metadata
    ) VALUES (
      v_target_org, v_target_user, v_role_id, v_user_id,
      CASE WHEN v_reason IS NOT NULL
           THEN jsonb_build_object('grant_reason', v_reason)
           ELSE '{}'::jsonb END
    )
    RETURNING id INTO v_assignment_id;
    v_action := 'granted';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'users.grant_role', 'rbac_user_role_assignment', v_assignment_id,
    'grant_user_role_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'role_id', v_role_id,
      'role_key', v_role_key,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    'grant_user_role_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'users.role_' || v_action, 'rbac_user_role_assignment', v_assignment_id,
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'role_id', v_role_id,
      'role_key', v_role_key,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'rbac_user_role_assignment_id', v_assignment_id,
    'action', v_action,
    'idempotent_no_op', v_idempotent,
    'target_user_id', v_target_user,
    'role_id', v_role_id,
    'role_key', v_role_key,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_user_role_v1(p_args jsonb)
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
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_role_key TEXT := NULLIF(btrim(COALESCE(p_args->>'role_key', '')), '');
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
  v_user_org UUID;
  v_role_id UUID;
  v_role_org UUID;
  v_before public.rbac_user_role_assignments%ROWTYPE;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'revoke_user_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.manage');

  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'revoke_user_role_v1 requires target_user_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_role_key IS NULL THEN
    RAISE EXCEPTION 'revoke_user_role_v1 requires role_key'
      USING ERRCODE = '23502';
  END IF;

  SELECT u.organization_id INTO v_user_org
    FROM public.users u
   WHERE u.id = v_target_user;
  IF v_user_org IS NULL THEN
    RAISE EXCEPTION 'revoke_user_role_v1 target user % not found', v_target_user
      USING ERRCODE = '23503';
  END IF;

  v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_user_org);
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'revoke_user_role_v1 target user % outside tenant scope', v_target_user
      USING ERRCODE = '42501';
  END IF;
  IF v_user_org <> v_target_org THEN
    RAISE EXCEPTION 'revoke_user_role_v1 organization mismatch (user %, target %)',
      v_user_org, v_target_org
      USING ERRCODE = '23514';
  END IF;

  SELECT r.id, r.organization_id INTO v_role_id, v_role_org
    FROM public.rbac_roles r
   WHERE r.organization_id = v_target_org
     AND r.key = v_role_key
   LIMIT 1;
  IF v_role_id IS NULL THEN
    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, v_target_org,
      'users.revoke_role', 'user', v_target_user,
      'revoke_user_role_v1', 'noop',
      jsonb_strip_nulls(jsonb_build_object(
        'target_user_id', v_target_user,
        'role_key', v_role_key,
        'reason', v_reason,
        'idempotent_no_op', true,
        'noop_reason', 'role_key_not_found'
      )),
      'revoke_user_role_v1', v_correlation_id
    );
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'ok', true,
      'rbac_user_role_assignment_id', NULL,
      'action', 'noop',
      'idempotent_no_op', true,
      'target_user_id', v_target_user,
      'role_key', v_role_key,
      'correlation_id', v_correlation_id,
      'settings_resolution_id', v_decision_id
    ));
  END IF;
  IF v_role_org <> v_target_org THEN
    RAISE EXCEPTION 'revoke_user_role_v1 role/org mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_before
    FROM public.rbac_user_role_assignments
   WHERE organization_id = v_target_org
     AND user_id = v_target_user
     AND role_id = v_role_id
     AND revoked_at IS NULL
   ORDER BY assigned_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_before.id IS NULL THEN
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    UPDATE public.rbac_user_role_assignments
       SET revoked_at = now(),
           revoked_by_user_id = v_user_id,
           metadata = CASE WHEN v_reason IS NOT NULL
                           THEN COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('revoke_reason', v_reason)
                           ELSE metadata END,
           updated_at = now()
     WHERE id = v_before.id;
    v_action := 'revoked';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'users.revoke_role',
    CASE WHEN v_before.id IS NULL THEN 'user' ELSE 'rbac_user_role_assignment' END,
    COALESCE(v_before.id, v_target_user),
    'revoke_user_role_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'role_id', v_role_id,
      'role_key', v_role_key,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    'revoke_user_role_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org,
    'users.role_' || v_action,
    CASE WHEN v_before.id IS NULL THEN 'user' ELSE 'rbac_user_role_assignment' END,
    COALESCE(v_before.id, v_target_user),
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'role_id', v_role_id,
      'role_key', v_role_key,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'rbac_user_role_assignment_id', v_before.id,
    'action', v_action,
    'idempotent_no_op', v_idempotent,
    'target_user_id', v_target_user,
    'role_id', v_role_id,
    'role_key', v_role_key,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.suspend_user_v1(p_args jsonb)
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
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
  v_prior_status TEXT;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'suspend_user_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.manage');

  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'suspend_user_v1 requires target_user_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_user_id = v_target_user THEN
    RAISE EXCEPTION 'suspend_user_v1 cannot suspend the calling user'
      USING ERRCODE = '23514';
  END IF;

  SELECT u.organization_id, u.status INTO v_target_org, v_prior_status
    FROM public.users u
   WHERE u.id = v_target_user
   FOR UPDATE;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'suspend_user_v1 target user % not found', v_target_user
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'suspend_user_v1 target user % outside tenant scope', v_target_user
      USING ERRCODE = '42501';
  END IF;

  IF v_prior_status = 'suspended' THEN
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    UPDATE public.users
       SET status = 'suspended'
     WHERE id = v_target_user;
    v_action := 'suspended';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'users.suspend', 'user', v_target_user,
    'suspend_user_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'prior_status', v_prior_status,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    'suspend_user_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'users.suspended', 'user', v_target_user,
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'prior_status', v_prior_status,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'target_user_id', v_target_user,
    'status', 'suspended',
    'prior_status', v_prior_status,
    'action', v_action,
    'idempotent_no_op', v_idempotent,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.reactivate_user_v1(p_args jsonb)
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
  v_target_user UUID := NULLIF(p_args->>'target_user_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_target_org UUID;
  v_prior_status TEXT;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'reactivate_user_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.manage');

  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'reactivate_user_v1 requires target_user_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT u.organization_id, u.status INTO v_target_org, v_prior_status
    FROM public.users u
   WHERE u.id = v_target_user
   FOR UPDATE;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'reactivate_user_v1 target user % not found', v_target_user
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'reactivate_user_v1 target user % outside tenant scope', v_target_user
      USING ERRCODE = '42501';
  END IF;

  IF v_prior_status = 'active' THEN
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    UPDATE public.users
       SET status = 'active'
     WHERE id = v_target_user;
    v_action := 'reactivated';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'users.reactivate', 'user', v_target_user,
    'reactivate_user_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'prior_status', v_prior_status,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    'reactivate_user_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'users.reactivated', 'user', v_target_user,
    jsonb_strip_nulls(jsonb_build_object(
      'target_user_id', v_target_user,
      'prior_status', v_prior_status,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'target_user_id', v_target_user,
    'status', 'active',
    'prior_status', v_prior_status,
    'action', v_action,
    'idempotent_no_op', v_idempotent,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

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

  WITH decision_scope AS (
    SELECT dl.*
      FROM public.decision_log dl
     WHERE dl.organization_id = v_target_org
       AND dl.decision_point IN (
         'grant_user_role_v1',
         'revoke_user_role_v1',
         'revoke_session_v1',
         'suspend_user_v1',
         'reactivate_user_v1',
         'force_password_reset_v1',
         'tenant_user_invite_apply_v1'
       )
       AND (
         (dl.resource_type = 'user' AND dl.resource_id = p_target_user_id)
         OR dl.decision_inputs->>'target_user_id' = p_target_user_id::text
       )
  )
  SELECT COUNT(*) INTO v_total FROM decision_scope;

  WITH decision_scope AS (
    SELECT dl.*
      FROM public.decision_log dl
     WHERE dl.organization_id = v_target_org
       AND dl.decision_point IN (
         'grant_user_role_v1',
         'revoke_user_role_v1',
         'revoke_session_v1',
         'suspend_user_v1',
         'reactivate_user_v1',
         'force_password_reset_v1',
         'tenant_user_invite_apply_v1'
       )
       AND (
         (dl.resource_type = 'user' AND dl.resource_id = p_target_user_id)
         OR dl.decision_inputs->>'target_user_id' = p_target_user_id::text
       )
  )
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
      FROM decision_scope dl
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

REVOKE ALL ON FUNCTION public.grant_user_role_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_user_role_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.suspend_user_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reactivate_user_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.grant_user_role_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_user_role_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.suspend_user_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reactivate_user_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.grant_user_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.grant_user_role_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.revoke_user_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.revoke_user_role_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.suspend_user_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.suspend_user_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.reactivate_user_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.reactivate_user_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.ui_list_user_security_actions_v1(
  p_target_user_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO api, public, pg_temp
AS $$
  SELECT public.ui_list_user_security_actions_v1($1, $2);
$$;

REVOKE ALL ON FUNCTION api.grant_user_role_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.revoke_user_role_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.suspend_user_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.reactivate_user_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.grant_user_role_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.revoke_user_role_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.suspend_user_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.reactivate_user_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION api.grant_user_role_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.revoke_user_role_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.suspend_user_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.reactivate_user_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_list_user_security_actions_v1(UUID, INTEGER) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_list_user_security_actions_v1(UUID, INTEGER)
  IS 'Console V2 drawer security-action evidence for user lifecycle decisions. Includes user-row decisions and RBAC assignment decisions scoped by decision_inputs.target_user_id.';
COMMENT ON FUNCTION api.revoke_user_role_v1(jsonb)
  IS 'Console V2 api schema wrapper exposing public.revoke_user_role_v1 for hosted browser clients.';

SELECT pg_advisory_unlock(hashtext('202605201735_user_lifecycle_security_action_readback_v1'));
COMMIT;
