-- Spec-Issue: Wave 6 W6-2 RBAC role-management lifecycle (Phase E3 / IDENTITY P0)
-- Step: B-RPC-RBAC-Grant-Role
-- Capability: access_policy.approve
--
-- Behavior: canonical assignment RPC for public.rbac_user_role_assignments.
-- Idempotent on (organization_id, user_id, role_id) where revoked_at IS NULL
-- (active assignment unique index). If an active assignment already exists,
-- returns it with idempotent_no_op=true. Otherwise inserts a new active
-- assignment with assigned_by_user_id = caller.
--
-- Org-consistency is enforced by the rbac_user_role_assignments_validate_v1
-- trigger (foundation v1 migration). The RPC additionally guards tenant scope
-- before issuing the insert so non-platform callers cannot grant cross-tenant.
--
-- Canonical envelope: { ok, rbac_user_role_assignment_id, action,
-- idempotent_no_op, correlation_id, settings_resolution_id }.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604290130_rbac_grant_role_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.rbac_grant_role_v1(p_args jsonb)
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
  v_target_org UUID;
  v_grant_user UUID := NULLIF(p_args->>'user_id', '')::uuid;
  v_role_id UUID := NULLIF(p_args->>'role_id', '')::uuid;
  v_assignment_id UUID;
  v_existing_id UUID;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
  v_user_org UUID;
  v_role_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'rbac_grant_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.approve');

  IF v_grant_user IS NULL THEN
    RAISE EXCEPTION 'rbac_grant_role_v1 requires user_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'rbac_grant_role_v1 requires role_id'
      USING ERRCODE = '23502';
  END IF;

  v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_org_id);
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'rbac_grant_role_v1 cannot resolve target organization'
      USING ERRCODE = '23502';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'rbac_grant_role_v1 organization_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;

  -- Pre-flight org consistency (also enforced by trigger; surfaces clearer error).
  SELECT u.organization_id INTO v_user_org FROM public.users u WHERE u.id = v_grant_user;
  SELECT r.organization_id INTO v_role_org FROM public.rbac_roles r WHERE r.id = v_role_id;
  IF v_user_org IS NULL THEN
    RAISE EXCEPTION 'rbac_grant_role_v1 user % not found', v_grant_user
      USING ERRCODE = '23503';
  END IF;
  IF v_role_org IS NULL THEN
    RAISE EXCEPTION 'rbac_grant_role_v1 role % not found', v_role_id
      USING ERRCODE = '23503';
  END IF;
  IF v_user_org <> v_target_org OR v_role_org <> v_target_org THEN
    RAISE EXCEPTION 'rbac_grant_role_v1 organization mismatch (user %, role %, target %)',
      v_user_org, v_role_org, v_target_org
      USING ERRCODE = '23514';
  END IF;

  -- Idempotent path: active assignment already exists?
  SELECT id INTO v_existing_id
    FROM public.rbac_user_role_assignments
   WHERE organization_id = v_target_org
     AND user_id = v_grant_user
     AND role_id = v_role_id
     AND revoked_at IS NULL
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    v_assignment_id := v_existing_id;
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    INSERT INTO public.rbac_user_role_assignments (
      organization_id, user_id, role_id, assigned_by_user_id
    ) VALUES (
      v_target_org, v_grant_user, v_role_id, v_user_id
    )
    RETURNING id INTO v_assignment_id;
    v_action := 'granted';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'access_policy.rbac_grant_role', 'rbac_user_role_assignment', v_assignment_id,
    'rbac_grant_role_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'user_id', v_grant_user,
      'role_id', v_role_id,
      'idempotent_no_op', v_idempotent
    )),
    'rbac_grant_role_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'rbac_user_role_assignment.' || v_action, 'rbac_user_role_assignment', v_assignment_id,
    jsonb_strip_nulls(jsonb_build_object(
      'user_id', v_grant_user,
      'role_id', v_role_id,
      'idempotent_no_op', v_idempotent
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'rbac_user_role_assignment_id', v_assignment_id,
    'action', v_action,
    'idempotent_no_op', v_idempotent,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.rbac_grant_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rbac_grant_role_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rbac_grant_role_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.rbac_grant_role_v1(jsonb)
  IS 'Canonical write RPC: insert public.rbac_user_role_assignments active row (org-scoped). Capability: access_policy.approve. Idempotent on (org, user, role) where revoked_at IS NULL. Org-consistency enforced by trigger.';

SELECT pg_advisory_unlock(hashtext('202604290130_rbac_grant_role_v1'));
COMMIT;
