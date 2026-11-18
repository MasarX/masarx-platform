-- Spec-Issue: Phase B1 - Platform RPC contract: create_alert_rule_v1
-- Step: B1-RPC-1
-- Migration: Canonical write RPC public.create_alert_rule_v1(p_args jsonb).
-- Capability: alerts.write
-- Contract:
--   p_args := {
--     "rule_name": "string (required)",
--     "trigger_source": "string (required)",
--     "trigger_conditions": jsonb (required, JSONLogic shape),
--     "alert_channels": jsonb (required),
--     "priority": int (optional, default 0),
--     "throttle_window_minutes": int (optional, default 15),
--     "throttle_key_fields": jsonb (optional),
--     "alert_severity_lookup_id": uuid (optional),
--     "message_template_id": uuid (optional),
--     "message_variables": jsonb (optional),
--     "enabled": boolean (optional, default true)
--   }
--   Returns: { ok, alert_rule_id, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280011_create_alert_rule_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.create_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID := gen_random_uuid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_rule_name TEXT := NULLIF(btrim(COALESCE(p_args->>'rule_name', '')), '');
  v_trigger_source TEXT := NULLIF(btrim(COALESCE(p_args->>'trigger_source', '')), '');
  v_trigger_conditions JSONB := COALESCE(p_args->'trigger_conditions', NULL);
  v_alert_channels JSONB := COALESCE(p_args->'alert_channels', NULL);
  v_priority INT := COALESCE((p_args->>'priority')::int, 0);
  v_throttle_min INT := COALESCE((p_args->>'throttle_window_minutes')::int, 15);
  v_throttle_keys JSONB := p_args->'throttle_key_fields';
  v_severity_id UUID := NULLIF(p_args->>'alert_severity_lookup_id', '')::uuid;
  v_template_id UUID := NULLIF(p_args->>'message_template_id', '')::uuid;
  v_message_vars JSONB := p_args->'message_variables';
  v_enabled BOOLEAN := COALESCE((p_args->>'enabled')::boolean, TRUE);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_alert_rule_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('alerts.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_alert_rule_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  IF v_rule_name IS NULL THEN
    RAISE EXCEPTION 'create_alert_rule_v1 requires rule_name'
      USING ERRCODE = '23502';
  END IF;

  IF v_trigger_source IS NULL THEN
    RAISE EXCEPTION 'create_alert_rule_v1 requires trigger_source'
      USING ERRCODE = '23502';
  END IF;

  IF v_trigger_conditions IS NULL OR jsonb_typeof(v_trigger_conditions) <> 'object' THEN
    RAISE EXCEPTION 'create_alert_rule_v1 requires trigger_conditions JSONLogic object'
      USING ERRCODE = '22023';
  END IF;

  IF v_alert_channels IS NULL OR jsonb_typeof(v_alert_channels) <> 'array' THEN
    RAISE EXCEPTION 'create_alert_rule_v1 requires alert_channels array'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.alert_rules (
    id,
    organization_id,
    rule_name,
    enabled,
    priority,
    trigger_source,
    trigger_conditions,
    throttle_window_minutes,
    throttle_key_fields,
    alert_severity_lookup_id,
    alert_channels,
    message_template_id,
    message_variables,
    created_by,
    updated_by,
    created_at,
    updated_at
  ) VALUES (
    v_resource_id,
    v_org_id,
    v_rule_name,
    v_enabled,
    v_priority,
    v_trigger_source,
    v_trigger_conditions,
    v_throttle_min,
    v_throttle_keys,
    v_severity_id,
    v_alert_channels,
    v_template_id,
    v_message_vars,
    v_user_id,
    v_user_id,
    now(),
    now()
  );

  -- Append decision_log entry
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_org_id, 'alerts.create', 'alert_rule', v_resource_id,
    'create_alert_rule_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object('rule_name', v_rule_name, 'trigger_source', v_trigger_source)),
    'create_alert_rule_v1', v_correlation_id::uuid
  );

  -- Append domain event (engine-first ledger)
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_org_id, 'alert_rule.created', 'alert_rule', v_resource_id,
    jsonb_build_object('rule_name', v_rule_name, 'enabled', v_enabled),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'alert_rule_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_alert_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_alert_rule_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_alert_rule_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.create_alert_rule_v1(jsonb)
  IS 'Canonical write RPC: create alert_rules row. Capability: alerts.write. Emits domain_events + decision_log.';

SELECT pg_advisory_unlock(hashtext('202604280011_create_alert_rule_v1'));
COMMIT;
