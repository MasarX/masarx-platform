-- Plan: PLAN-202512-logging-enterprise-grade-v2 / Step: S02
-- Migration: Enrich provider_health_logs emission from circuit_breaker_state transitions
-- Purpose: Populate organization_id + correlation_id and log all state/manual-intervention transitions.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_provider_health_from_circuit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_org UUID;
  v_corr UUID;
  v_status TEXT;
  v_error TEXT;
BEGIN
  -- Emit only on meaningful transitions (state change or manual intervention toggle).
  IF (OLD.state IS NOT DISTINCT FROM NEW.state)
     AND (OLD.manual_intervention_required IS NOT DISTINCT FROM NEW.manual_intervention_required) THEN
    RETURN NEW;
  END IF;

  v_org := resolve_organization_id_strict('provider', NEW.provider_id);

  v_corr := public.current_correlation_id();
  IF v_corr IS NULL THEN
    v_corr := gen_random_uuid();
  END IF;

  v_status := CASE
    WHEN NEW.manual_intervention_required THEN 'manual_intervention_required'
    WHEN NEW.state = 'open' THEN 'down'
    WHEN NEW.state = 'half_open' THEN 'degraded'
    WHEN NEW.state = 'closed' THEN 'healthy'
    ELSE COALESCE(NEW.state, 'unknown')
  END;

  v_error := CASE
    WHEN NEW.manual_intervention_required THEN 'manual intervention required'
    WHEN NEW.state IN ('open', 'half_open') THEN 'circuit breaker ' || NEW.state
    ELSE NULL
  END;

  INSERT INTO public.provider_health_logs (
    organization_id,
    provider_id,
    status,
    error_message,
    metadata,
    decision_log_id,
    correlation_id,
    created_at
  )
  VALUES (
    v_org,
    NEW.provider_id,
    v_status,
    v_error,
    jsonb_strip_nulls(jsonb_build_object(
      'operation_name', NEW.operation_name,
      'old_state', OLD.state,
      'new_state', NEW.state,
      'failure_count', NEW.failure_count,
      'success_count', NEW.success_count,
      'reopen_count', NEW.reopen_count,
      'manual_intervention_required', NEW.manual_intervention_required
    )),
    NULL,
    v_corr,
    now()
  );

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.log_provider_health_from_circuit()
  SET search_path = public, extensions, pg_temp;

COMMIT;

