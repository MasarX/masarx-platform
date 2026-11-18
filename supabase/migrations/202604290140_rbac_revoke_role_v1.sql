-- Spec-Issue: Wave 6 W6-2 RBAC role-management lifecycle (Phase E3 / IDENTITY P0)
-- Step: B-RPC-RBAC-Revoke-Role
-- Capability: access_policy.approve
--
-- Behavior: canonical revoke RPC for public.rbac_user_role_assignments.
-- Two resolution modes:
--   * Direct: p_args->>'assignment_id' is set -> targets that exact row.
--   * Logical: p_args->>'user_id' + p_args->>'role_id' (+ org) -> resolves
--     the unique active assignment.
-- Sets revoked_at = now() and revoked_by_user_id = caller. Optional
-- p_args->>'reason' is recorded in metadata + decision_log inputs.
-- Idempotent: revoking an already-revoked assignment returns
-- idempotent_no_op=true.
--
-- Canonical envelope: { ok, rbac_user_role_assignment_id, action,
-- idempotent_no_op, correlation_id, settings_resolution_id }.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604290140_rbac_revoke_role_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.rbac_revoke_role_v1(p_args jsonb)
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
  v_assignment_id UUID := NULLIF(p_args->>'assignment_id', '')::uuid;
  v_target_user UUID := NULLIF(p_args->>'user_id', '')::uuid;
  v_role_id UUID := NULLIF(p_args->>'role_id', '')::uuid;
  v_target_org UUID;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_before public.rbac_user_role_assignments%ROWTYPE;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'rbac_revoke_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.approve');

  -- Resolve assignment row.
  IF v_assignment_id IS NOT NULL THEN
    SELECT * INTO v_before
      FROM public.rbac_user_role_assignments
     WHERE id = v_assignment_id
     FOR UPDATE;
    IF v_before.id IS NULL THEN
      RAISE EXCEPTION 'rbac_revoke_role_v1 assignment % not found', v_assignment_id
        USING ERRCODE = '23503';
    END IF;
  ELSE
    IF v_target_user IS NULL OR v_role_id IS NULL THEN
      RAISE EXCEPTION 'rbac_revoke_role_v1 requires assignment_id or (user_id + role_id)'
        USING ERRCODE = '23502';
    END IF;
    v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_org_id);
    IF v_target_org IS NULL THEN
      RAISE EXCEPTION 'rbac_revoke_role_v1 cannot resolve target organization'
        USING ERRCODE = '23502';
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
      -- No active assignment = idempotent no-op (already revoked).
      RETURN jsonb_strip_nulls(jsonb_build_object(
        'ok', true,
        'rbac_user_role_assignment_id', NULL,
        'action', 'noop',
        'idempotent_no_op', true,
        'correlation_id', v_correlation_id,
        'settings_resolution_id', v_decision_id
      ));
    END IF;
    v_assignment_id := v_before.id;
  END IF;

  -- Tenant scope guard.
  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'rbac_revoke_role_v1 assignment % outside tenant scope', v_assignment_id
      USING ERRCODE = '42501';
  END IF;

  IF v_before.revoked_at IS NOT NULL THEN
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
     WHERE id = v_assignment_id;
    v_action := 'revoked';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id,
    'access_policy.rbac_revoke_role', 'rbac_user_role_assignment', v_assignment_id,
    'rbac_revoke_role_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'user_id', v_before.user_id,
      'role_id', v_before.role_id,
      'reason', v_reason,
      'idempotent_no_op', v_idempotent
    )),
    'rbac_revoke_role_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_before.organization_id, 'rbac_user_role_assignment.' || v_action,
    'rbac_user_role_assignment', v_assignment_id,
    jsonb_strip_nulls(jsonb_build_object(
      'user_id', v_before.user_id,
      'role_id', v_before.role_id,
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
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.rbac_revoke_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rbac_revoke_role_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rbac_revoke_role_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.rbac_revoke_role_v1(jsonb)
  IS 'Canonical write RPC: revoke public.rbac_user_role_assignments active row (org-scoped). Capability: access_policy.approve. Accepts assignment_id OR (user_id + role_id + org). Idempotent on already-revoked rows.';

SELECT pg_advisory_unlock(hashtext('202604290140_rbac_revoke_role_v1'));
COMMIT;
