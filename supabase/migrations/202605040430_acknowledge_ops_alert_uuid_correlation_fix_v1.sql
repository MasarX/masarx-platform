BEGIN;

SELECT pg_advisory_lock(hashtext('202605031520_acknowledge_ops_alert_uuid_correlation_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.acknowledge_ops_alert_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_alert_id UUID := NULLIF(p_args->>'ops_alert_id', '')::uuid;
  v_alert_org UUID := NULLIF(p_args->>'organization_id', '')::uuid;
  v_alert_created TIMESTAMPTZ := NULLIF(p_args->>'created_at', '')::timestamptz;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_notes TEXT := NULLIF(btrim(p_args->>'notes'), '');
  v_alert RECORD;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  BEGIN
    v_correlation_id := COALESCE(NULLIF(p_args->>'correlation_id', '')::uuid, v_correlation_id);
  EXCEPTION
    WHEN others THEN
      v_correlation_id := gen_random_uuid();
  END;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'acknowledge_ops_alert_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('alerts.write');

  IF v_alert_id IS NULL THEN
    RAISE EXCEPTION 'acknowledge_ops_alert_v1 requires ops_alert_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT id, organization_id, created_at, acknowledged_at, acknowledged_by_user_id, resolved_at
    INTO v_alert
    FROM public.ops_alerts
   WHERE id = v_alert_id
     AND (v_alert_org IS NULL OR organization_id = v_alert_org)
     AND (v_alert_created IS NULL OR created_at = v_alert_created)
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_alert.id IS NULL THEN
    RAISE EXCEPTION 'acknowledge_ops_alert_v1 ops_alert % not found', v_alert_id
      USING ERRCODE = '23503';
  END IF;

  IF v_org_id IS NOT NULL AND v_alert.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'acknowledge_ops_alert_v1 ops_alert % outside tenant scope', v_alert_id
      USING ERRCODE = '42501';
  END IF;

  IF v_alert.acknowledged_at IS NULL THEN
    UPDATE public.ops_alerts
       SET acknowledged_at = now(),
           acknowledged_by_user_id = v_user_id
     WHERE id = v_alert.id
       AND organization_id = v_alert.organization_id
       AND created_at = v_alert.created_at;
  ELSE
    v_idempotent := TRUE;
  END IF;

  INSERT INTO public.ops_alert_events (
    ops_alert_id, organization_id, event_type, notes, acted_by,
    correlation_id, decision_log_id, settings_resolution_id, payload
  ) VALUES (
    v_alert.id, v_alert.organization_id, 'acknowledged', v_notes, v_user_id,
    v_correlation_id, v_decision_id, NULL,
    jsonb_strip_nulls(jsonb_build_object('idempotent', v_idempotent))
  );

  IF NOT v_idempotent THEN
    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, v_alert.organization_id, 'alerts.acknowledge', 'ops_alert', v_alert.id,
      'acknowledge_ops_alert_v1', 'acknowledged', 'acknowledge_ops_alert_v1', v_correlation_id
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_alert.organization_id, 'ops_alert.acknowledged', 'ops_alert', v_alert.id,
      '{}'::jsonb, v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'ops_alert_id', v_alert.id,
    'idempotent', v_idempotent,
    'acknowledged_at', COALESCE(v_alert.acknowledged_at, now()),
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_ops_alert_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_ops_alert_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_ops_alert_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.acknowledge_ops_alert_v1(jsonb)
  IS 'Acknowledge an ops alert via canonical RPC; appends ops_alert_events and decision/domain events with UUID correlation IDs.';

SELECT pg_advisory_unlock(hashtext('202605031520_acknowledge_ops_alert_uuid_correlation_fix_v1'));

COMMIT;
