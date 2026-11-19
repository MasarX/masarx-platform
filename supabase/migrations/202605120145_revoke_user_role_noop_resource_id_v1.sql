-- Fix revoke_user_role_v1 idempotent no-op audit resource IDs.
-- The Console V2 user lifecycle readback requires revoke no-op to remain
-- backend-backed and audit-safe. When no assignment exists, the decision/event
-- resource is the target user instead of a null assignment id.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120145_revoke_user_role_noop_resource_id_v1'));
SET search_path TO public, extensions, pg_temp;

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
    FROM public.users u WHERE u.id = v_target_user;
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
    CASE WHEN v_before.id IS NULL THEN v_target_user ELSE v_before.id END,
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
    v_target_org, 'users.role_' || v_action,
    CASE WHEN v_before.id IS NULL THEN 'user' ELSE 'rbac_user_role_assignment' END,
    CASE WHEN v_before.id IS NULL THEN v_target_user ELSE v_before.id END,
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

REVOKE ALL ON FUNCTION public.revoke_user_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_user_role_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_role_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.revoke_user_role_v1(jsonb)
  IS 'Canonical operator write RPC: revoke rbac role from user by role_key. Capability: users.manage. Idempotent no-op audit rows use target user resource when no assignment exists.';

SELECT pg_advisory_unlock(hashtext('202605120145_revoke_user_role_noop_resource_id_v1'));
COMMIT;
