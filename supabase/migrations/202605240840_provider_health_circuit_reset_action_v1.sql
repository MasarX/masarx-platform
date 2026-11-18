-- Console V2 Provider Health circuit reset action.
--
-- Provider Health already exposes live circuit-breaker telemetry. This adds the
-- browser-safe operator action for a recovered provider so the open drawer can
-- reconcile the same backend state without waiting for a scheduled worker tick.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605240840_provider_health_circuit_reset_action_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_execute_provider_circuit_reset_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor_user_id uuid := auth.uid();
  v_provider_id uuid := NULLIF(p_args->>'provider_id', '')::uuid;
  v_operation_name text := NULLIF(btrim(COALESCE(p_args->>'operation_name', '')), '');
  v_reason text := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_correlation_id uuid := gen_random_uuid();
  v_decision_log_id uuid := gen_random_uuid();
  v_circuit public.circuit_breaker_state%ROWTYPE;
  v_provider public.providers%ROWTYPE;
  v_scope_org uuid;
  v_previous_state text;
  v_previous_failure_count integer;
  v_previous_manual_intervention boolean;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_provider_circuit_reset_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_provider_circuit_reset_v1 requires provider_id'
      USING ERRCODE = '23502';
  END IF;

  IF v_operation_name IS NULL THEN
    RAISE EXCEPTION 'ui_execute_provider_circuit_reset_v1 requires operation_name'
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_provider
    FROM public.providers
   WHERE id = v_provider_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_provider_circuit_reset_v1 provider % not found', v_provider_id
      USING ERRCODE = '23503';
  END IF;

  v_scope_org := public.current_user_org_id();
  IF v_scope_org IS NOT NULL
     AND v_scope_org <> v_provider.organization_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_execute_provider_circuit_reset_v1 provider % outside tenant scope', v_provider_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.user_has_capability_v1('integrations.write', 'tenant', v_provider.organization_id)
    OR public.user_has_capability_v1('integration_plugins.write', 'tenant', v_provider.organization_id)
  ) THEN
    RAISE EXCEPTION 'Capability denied: integrations.write'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_circuit
    FROM public.circuit_breaker_state
   WHERE provider_id = v_provider_id
     AND operation_name = v_operation_name
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_provider_circuit_reset_v1 circuit %:% not found', v_provider_id, v_operation_name
      USING ERRCODE = '23503';
  END IF;

  v_previous_state := v_circuit.state;
  v_previous_failure_count := COALESCE(v_circuit.failure_count, 0);
  v_previous_manual_intervention := COALESCE(v_circuit.manual_intervention_required, false);

  UPDATE public.circuit_breaker_state
     SET state = 'closed',
         failure_count = 0,
         success_count = COALESCE(success_count, 0) + 1,
         last_success_at = now(),
         last_recovery_attempt_at = now(),
         opened_at = NULL,
         half_open_test_at = NULL,
         manual_intervention_required = false,
         updated_at = now()
   WHERE id = v_circuit.id
   RETURNING * INTO v_circuit;

  UPDATE public.providers
     SET health_status = 'healthy',
         updated_at = now()
   WHERE id = v_provider.id;

  INSERT INTO public.decision_log (
    id,
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    decision_reason,
    performed_by_system,
    correlation_id,
    timestamp
  ) VALUES (
    v_decision_log_id,
    v_provider.organization_id,
    'circuit_breaker',
    'circuit_breaker_state',
    v_circuit.id,
    'operator_reset',
    'reset',
    jsonb_strip_nulls(jsonb_build_object(
      'provider_id', v_provider.id,
      'provider_name', v_provider.name,
      'operation_name', v_operation_name,
      'previous_state', v_previous_state,
      'previous_failure_count', v_previous_failure_count,
      'previous_manual_intervention_required', v_previous_manual_intervention,
      'new_state', v_circuit.state,
      'reason', v_reason
    )),
    COALESCE(v_reason, 'Operator reset provider circuit after recovery.'),
    'ui_execute_provider_circuit_reset_v1',
    v_correlation_id,
    now()
  );

  RETURN jsonb_build_object(
    'ok', true,
    'provider_id', v_provider.id,
    'provider_name', v_provider.name,
    'operation_name', v_operation_name,
    'circuit_breaker_id', v_circuit.id,
    'state', v_circuit.state,
    'health_status', 'healthy',
    'failure_count', v_circuit.failure_count,
    'success_count', v_circuit.success_count,
    'decision_log_id', v_decision_log_id,
    'correlation_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_execute_provider_circuit_reset_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_provider_circuit_reset_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_provider_circuit_reset_v1(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_provider_circuit_reset_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.ui_execute_provider_circuit_reset_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION api.ui_execute_provider_circuit_reset_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_provider_circuit_reset_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_provider_circuit_reset_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_execute_provider_circuit_reset_v1(jsonb)
  IS 'Operator-facing Console V2 action to reset a tenant-visible provider circuit breaker after recovery, with capability gate, decision log, provider health log trigger, and backend readback evidence.';

COMMENT ON FUNCTION api.ui_execute_provider_circuit_reset_v1(jsonb)
  IS 'API-schema wrapper for Console V2 provider circuit reset action.';

SELECT pg_advisory_unlock(hashtext('202605240840_provider_health_circuit_reset_action_v1'));
COMMIT;
