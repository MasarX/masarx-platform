-- Spec-Issue: Phase B1 - Platform RPC contract: resume_alert_rule_v1
-- Step: B1-RPC-4
-- Capability: alerts.write (idempotent; sets enabled=true)

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280041_resume_alert_rule_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.resume_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_resource_id UUID := NULLIF(p_args->>'alert_rule_id', '')::uuid;
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_rule public.alert_rules%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resume_alert_rule_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('alerts.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'resume_alert_rule_v1 requires alert_rule_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_rule
    FROM public.alert_rules
   WHERE id = v_resource_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF v_rule.id IS NULL THEN
    RAISE EXCEPTION 'resume_alert_rule_v1 alert rule % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_rule.enabled THEN
    UPDATE public.alert_rules
       SET enabled = TRUE,
           updated_by = v_user_id,
           updated_at = now()
     WHERE id = v_resource_id;

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, v_rule.organization_id, 'alerts.resume', 'alert_rule', v_resource_id,
      'resume_alert_rule_v1', 'resumed', 'resume_alert_rule_v1', v_correlation_id::uuid
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_rule.organization_id, 'alert_rule.resumed', 'alert_rule', v_resource_id,
      '{}'::jsonb, v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'alert_rule_id', v_resource_id,
    'enabled', true,
    'idempotent', v_rule.enabled,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resume_alert_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resume_alert_rule_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resume_alert_rule_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.resume_alert_rule_v1(jsonb)
  IS 'Canonical write RPC: resume alert_rule (enabled=true, idempotent). Capability: alerts.write.';

SELECT pg_advisory_unlock(hashtext('202604280041_resume_alert_rule_v1'));
COMMIT;
