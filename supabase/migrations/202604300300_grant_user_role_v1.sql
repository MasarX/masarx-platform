-- Spec-Issue: Wave 8 W8-3 PLATFORM user-lifecycle RPC closure (CLAIM-PLATFORM-USERS)
-- Step: B-RPC-User-Grant-Role
-- Capability: users.manage
--
-- Behavior: canonical operator-surface wrapper for granting an RBAC role to a
-- user by canonical role_key (the operator console only knows role keys; this
-- RPC resolves the role_key -> role_id pair within the target organization
-- before delegating to the rbac assignment substrate).
--
-- This is intentionally a sibling of public.rbac_grant_role_v1: that RPC is
-- gated on `access_policy.approve` for RBAC catalog admins and accepts a
-- raw role_id; this RPC is gated on `users.manage` (the operator surface
-- capability) and accepts a role_key so the /platform/users surface can
-- write through a stable contract without knowing the RBAC internals.
--
-- Idempotent on (organization_id, user_id, role_id) where revoked_at IS NULL
-- via the unique partial index defined in 202601300030_rbac_foundation_v1.sql.
-- If an active assignment already exists, returns it with idempotent_no_op=true.
-- Otherwise inserts a new active assignment with assigned_by_user_id = caller.
--
-- Canonical envelope: { ok, rbac_user_role_assignment_id, action,
-- idempotent_no_op, target_user_id, role_id, role_key, correlation_id,
-- settings_resolution_id }.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300300_grant_user_role_v1'));
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
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
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

  -- Resolve target user's org first (so role_key resolves in the right tenant).
  SELECT u.organization_id INTO v_user_org
    FROM public.users u WHERE u.id = v_target_user;
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

  -- Resolve role_key -> role_id within target_org.
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

  -- Idempotent path: active assignment already exists?
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
      organization_id, user_id, role_id, assigned_by_user_id,
      metadata
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
    'grant_user_role_v1', v_correlation_id::uuid
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
    v_correlation_id::uuid, 'pending'
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

REVOKE ALL ON FUNCTION public.grant_user_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_user_role_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_user_role_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.grant_user_role_v1(jsonb)
  IS 'Canonical operator write RPC: assign rbac role to user by role_key. Capability: users.manage. Idempotent on (org, user, role) where revoked_at IS NULL.';

SELECT pg_advisory_unlock(hashtext('202604300300_grant_user_role_v1'));
COMMIT;
