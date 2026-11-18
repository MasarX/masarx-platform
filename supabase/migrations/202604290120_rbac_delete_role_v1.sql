-- Spec-Issue: Wave 6 W6-2 RBAC role-management lifecycle (Phase E3 / IDENTITY P0)
-- Step: B-RPC-RBAC-Delete-Role
-- Capability: access_policy.approve
--
-- Behavior: canonical soft-delete RPC for public.rbac_roles. The role row
-- stays in history (preserves audit trail) but is marked inactive
-- (is_active = FALSE) and all active user-role assignments referencing this
-- role are revoked atomically (revoked_at = now(), revoked_by_user_id =
-- caller). Idempotent: deleting an already-inactive role is a no-op
-- (idempotent_no_op=true) and emits an audit event without further mutation.
--
-- Canonical envelope: { ok, rbac_role_id, action, idempotent_no_op,
-- assignments_revoked, correlation_id, settings_resolution_id }.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604290120_rbac_delete_role_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.rbac_delete_role_v1(p_args jsonb)
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
  v_role_id UUID := NULLIF(p_args->>'role_id', '')::uuid;
  v_before public.rbac_roles%ROWTYPE;
  v_assignments_revoked INTEGER := 0;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'rbac_delete_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.approve');

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'rbac_delete_role_v1 requires role_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.rbac_roles WHERE id = v_role_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'rbac_delete_role_v1 role % not found', v_role_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'rbac_delete_role_v1 role % outside tenant scope', v_role_id
      USING ERRCODE = '42501';
  END IF;

  IF v_before.is_active = FALSE THEN
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    UPDATE public.rbac_roles
       SET is_active = FALSE,
           updated_at = now()
     WHERE id = v_role_id;

    -- Atomically revoke all active assignments referencing this role.
    WITH revoked AS (
      UPDATE public.rbac_user_role_assignments
         SET revoked_at = now(),
             revoked_by_user_id = v_user_id,
             updated_at = now()
       WHERE role_id = v_role_id
         AND revoked_at IS NULL
       RETURNING id
    )
    SELECT count(*) INTO v_assignments_revoked FROM revoked;

    v_action := 'deleted';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id,
    'access_policy.rbac_delete_role', 'rbac_role', v_role_id,
    'rbac_delete_role_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'role_key', v_before.key,
      'assignments_revoked', v_assignments_revoked,
      'idempotent_no_op', v_idempotent
    )),
    'rbac_delete_role_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_before.organization_id, 'rbac_role.' || v_action, 'rbac_role', v_role_id,
    jsonb_strip_nulls(jsonb_build_object(
      'role_key', v_before.key,
      'assignments_revoked', v_assignments_revoked,
      'idempotent_no_op', v_idempotent
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'rbac_role_id', v_role_id,
    'action', v_action,
    'idempotent_no_op', v_idempotent,
    'assignments_revoked', v_assignments_revoked,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.rbac_delete_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rbac_delete_role_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rbac_delete_role_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.rbac_delete_role_v1(jsonb)
  IS 'Canonical write RPC: soft-delete public.rbac_roles row (org-scoped). Capability: access_policy.approve. Sets is_active=FALSE and revokes all active user-role assignments atomically. Idempotent on already-inactive roles.';

SELECT pg_advisory_unlock(hashtext('202604290120_rbac_delete_role_v1'));
COMMIT;
