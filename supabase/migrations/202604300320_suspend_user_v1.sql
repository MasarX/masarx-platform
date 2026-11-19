-- Spec-Issue: Wave 8 W8-3 PLATFORM user-lifecycle RPC closure (CLAIM-PLATFORM-USERS)
-- Step: B-RPC-User-Suspend
-- Capability: users.manage
--
-- Behavior: canonical operator-surface RPC for suspending an application user.
-- Sets public.users.status = 'suspended' (the canonical column documented in
-- supabase/migrations/202510110002_configuration_core.sql:47-60 with lookup
-- category `user_status` values active/suspended).
--
-- Suspension at the public.users layer is the canonical authorization signal:
-- downstream policy (capability gates, RLS) evaluate against status='active'
-- and reject suspended users. Termination of any open auth.sessions is a
-- separate INTENT (revoke_session_v1); this RPC additionally enqueues a
-- domain event the edge worker can chain on if a tenant policy requires
-- automatic session sign-out on suspension.
--
-- Idempotent: suspending an already-suspended user returns
-- idempotent_no_op=true.
--
-- Canonical envelope: { ok, target_user_id, status, prior_status, action,
-- idempotent_no_op, correlation_id, settings_resolution_id }.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300320_suspend_user_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.suspend_user_v1(p_args jsonb)
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
    FROM public.users u WHERE u.id = v_target_user FOR UPDATE;
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
    'suspend_user_v1', v_correlation_id::uuid
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
    v_correlation_id::uuid, 'pending'
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

REVOKE ALL ON FUNCTION public.suspend_user_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suspend_user_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_user_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.suspend_user_v1(jsonb)
  IS 'Canonical operator write RPC: set public.users.status=suspended. Capability: users.manage. Idempotent on already-suspended target. Cannot suspend self.';

SELECT pg_advisory_unlock(hashtext('202604300320_suspend_user_v1'));
COMMIT;
