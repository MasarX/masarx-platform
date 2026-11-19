-- Spec-Issue: Phase B6 - Identity RPC contract: update_user_profile_v1
-- Step: B6-RPC-13
-- Capability: users.read (self-edit) — supplemented by self-only invariant.
--
-- Behavior:
--   * Caller can only update their own row (auth.uid() = users.id).
--   * users.manage capability allows operating on other users in same org.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280213_update_user_profile_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.update_user_profile_v1(p_args jsonb)
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
  v_target_user_id UUID := COALESCE(NULLIF(p_args->>'user_id', '')::uuid, auth.uid());
  v_before public.users%ROWTYPE;
  v_is_self BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'update_user_profile_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_is_self := (v_target_user_id = v_user_id);

  -- Self-edit allowed via users.read; cross-user edits require users.manage.
  IF v_is_self THEN
    PERFORM public.assert_capability_v1('users.read');
  ELSE
    PERFORM public.assert_capability_v1('users.manage');
  END IF;

  SELECT * INTO v_before FROM public.users WHERE id = v_target_user_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'update_user_profile_v1 user % not found', v_target_user_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'update_user_profile_v1 user % outside tenant scope', v_target_user_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.users
     SET full_name = COALESCE(NULLIF(btrim(p_args->>'full_name'), ''), full_name)
   WHERE id = v_target_user_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id, 'users.profile_update', 'user', v_target_user_id,
    'update_user_profile_v1', CASE WHEN v_is_self THEN 'self_updated' ELSE 'managed_updated' END,
    jsonb_strip_nulls(jsonb_build_object('is_self', v_is_self, 'fields', jsonb_build_array('full_name'))),
    'update_user_profile_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_before.organization_id, 'user.profile_updated', 'user', v_target_user_id,
    jsonb_build_object('is_self', v_is_self),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_target_user_id,
    'is_self', v_is_self,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_user_profile_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_user_profile_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_profile_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.update_user_profile_v1(jsonb)
  IS 'Canonical write RPC: update users.full_name (self via users.read; others via users.manage). Capability: users.read (self) | users.manage (other).';

SELECT pg_advisory_unlock(hashtext('202604280213_update_user_profile_v1'));
COMMIT;
