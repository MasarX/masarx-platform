-- Spec-Issue: Phase B1 - Platform RPC contract: engage_kill_switch_v1
-- Step: B1-RPC-10
-- Capability: feature_flags.write
-- Force-off + audit; appends feature_flag_kill_events with event_type='engaged'.
-- Captures prior_enabled/prior_rollout for restore-on-release.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280100_engage_kill_switch_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.engage_kill_switch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_flag_id UUID := NULLIF(p_args->>'feature_flag_id', '')::uuid;
  v_flag_name TEXT := NULLIF(btrim(p_args->>'name'), '');
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_reason TEXT := NULLIF(btrim(p_args->>'reason'), '');
  v_flag public.feature_flags%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'engage_kill_switch_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('feature_flags.write');

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'engage_kill_switch_v1 requires reason for audit trail'
      USING ERRCODE = '23502';
  END IF;

  IF v_flag_id IS NULL AND v_flag_name IS NULL THEN
    RAISE EXCEPTION 'engage_kill_switch_v1 requires feature_flag_id or name'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_flag
    FROM public.feature_flags
   WHERE (v_flag_id IS NULL OR id = v_flag_id)
     AND (v_flag_name IS NULL OR name = v_flag_name)
   ORDER BY updated_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_flag.id IS NULL THEN
    RAISE EXCEPTION 'engage_kill_switch_v1 feature_flag % not found',
      COALESCE(v_flag_id::text, v_flag_name)
      USING ERRCODE = '23503';
  END IF;

  -- Always append kill_events for engagement intent (audit even on idempotent)
  INSERT INTO public.feature_flag_kill_events (
    feature_flag_id, organization_id, event_type, reason,
    prior_enabled, prior_rollout_percentage,
    acted_by, correlation_id, decision_log_id, settings_resolution_id, payload
  ) VALUES (
    v_flag.id, v_org_id, 'engaged', v_reason,
    v_flag.enabled, v_flag.rollout_percentage,
    v_user_id, v_correlation_id, v_decision_id, NULL,
    jsonb_build_object('idempotent', NOT v_flag.enabled AND v_flag.rollout_percentage = 0)
  );

  IF v_flag.enabled OR v_flag.rollout_percentage > 0 THEN
    UPDATE public.feature_flags
       SET enabled = FALSE,
           rollout_percentage = 0,
           updated_at = now()
     WHERE id = v_flag.id;

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_reason, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, COALESCE(v_org_id, v_flag.scope_id),
      'feature_flags.kill_switch', 'feature_flag', v_flag.id,
      'engage_kill_switch_v1', 'engaged', v_reason,
      'engage_kill_switch_v1', v_correlation_id::uuid
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_org_id, v_flag.scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      'feature_flag.kill_switch_engaged', 'feature_flag', v_flag.id,
      jsonb_build_object('reason', v_reason, 'name', v_flag.name),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag.id,
    'enabled', false,
    'rollout_percentage', 0,
    'idempotent', NOT v_flag.enabled AND v_flag.rollout_percentage = 0,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.engage_kill_switch_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.engage_kill_switch_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engage_kill_switch_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.engage_kill_switch_v1(jsonb)
  IS 'Canonical write RPC: engage feature flag kill switch (force-off, audit). Capability: feature_flags.write.';

SELECT pg_advisory_unlock(hashtext('202604280100_engage_kill_switch_v1'));
COMMIT;
