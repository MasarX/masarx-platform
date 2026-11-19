-- Spec-Issue: Phase B1 - Platform RPC contract: update_alert_rule_v1
-- Step: B1-RPC-2
-- Capability: alerts.write
-- Append revision row to public.alert_rule_revisions before mutation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280021_update_alert_rule_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.update_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID := NULLIF(p_args->>'alert_rule_id', '')::uuid;
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_before public.alert_rules%ROWTYPE;
  v_next_revision INT;
  v_after JSONB;
  v_before_jsonb JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'update_alert_rule_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('alerts.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'update_alert_rule_v1 requires alert_rule_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before
    FROM public.alert_rules
   WHERE id = v_resource_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'update_alert_rule_v1 alert rule % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  IF v_org_id IS NOT NULL AND v_before.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'update_alert_rule_v1 alert rule % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  v_before_jsonb := to_jsonb(v_before);

  UPDATE public.alert_rules
     SET rule_name = COALESCE(NULLIF(btrim(p_args->>'rule_name'), ''), rule_name),
         enabled = COALESCE((p_args->>'enabled')::boolean, enabled),
         priority = COALESCE((p_args->>'priority')::int, priority),
         trigger_source = COALESCE(NULLIF(btrim(p_args->>'trigger_source'), ''), trigger_source),
         trigger_conditions = COALESCE(p_args->'trigger_conditions', trigger_conditions),
         throttle_window_minutes = COALESCE((p_args->>'throttle_window_minutes')::int, throttle_window_minutes),
         throttle_key_fields = COALESCE(p_args->'throttle_key_fields', throttle_key_fields),
         alert_severity_lookup_id = COALESCE(NULLIF(p_args->>'alert_severity_lookup_id', '')::uuid, alert_severity_lookup_id),
         alert_channels = COALESCE(p_args->'alert_channels', alert_channels),
         message_template_id = COALESCE(NULLIF(p_args->>'message_template_id', '')::uuid, message_template_id),
         message_variables = COALESCE(p_args->'message_variables', message_variables),
         updated_by = v_user_id,
         updated_at = now()
   WHERE id = v_resource_id
   RETURNING to_jsonb(alert_rules.*) INTO v_after;

  -- Compute next revision
  SELECT COALESCE(MAX(revision), 0) + 1
    INTO v_next_revision
    FROM public.alert_rule_revisions
   WHERE alert_rule_id = v_resource_id;

  INSERT INTO public.alert_rule_revisions (
    alert_rule_id, organization_id, revision,
    before_value, after_value,
    changed_by, correlation_id, decision_log_id, settings_resolution_id
  ) VALUES (
    v_resource_id, v_before.organization_id, v_next_revision,
    v_before_jsonb, v_after,
    v_user_id, v_correlation_id, v_decision_id, NULL
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id, 'alerts.update', 'alert_rule', v_resource_id,
    'update_alert_rule_v1', 'updated',
    jsonb_strip_nulls(jsonb_build_object('revision', v_next_revision)),
    'update_alert_rule_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_before.organization_id, 'alert_rule.updated', 'alert_rule', v_resource_id,
    jsonb_build_object('revision', v_next_revision),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'alert_rule_id', v_resource_id,
    'revision', v_next_revision,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_alert_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_alert_rule_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_alert_rule_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.update_alert_rule_v1(jsonb)
  IS 'Canonical write RPC: update alert_rules row + append alert_rule_revisions snapshot. Capability: alerts.write.';

SELECT pg_advisory_unlock(hashtext('202604280021_update_alert_rule_v1'));
COMMIT;
