-- Migration: Ops alerts and provider health emitters
-- Purpose: create triggers to populate ops_alerts on failed webhook responses and provider_health_logs on circuit breaker changes.

BEGIN;

-- Trigger function: on decision_log insert for webhook http responses
CREATE OR REPLACE FUNCTION public.log_ops_alert_from_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.decision_category = 'http_response_emitted'
     AND NEW.decision_outcome NOT IN ('succeeded','accepted_async') THEN
    INSERT INTO public.ops_alerts (
      organization_id,
      alert_type,
      severity,
      message,
      details,
      decision_log_id,
      correlation_id,
      created_at
    )
    VALUES (
      NEW.organization_id,
      'webhook_ack_failure',
      'critical',
      COALESCE(NEW.decision_reason, 'Webhook ACK failure'),
      NEW.decision_inputs,
      NEW.id,
      NEW.correlation_id,
      NEW."timestamp"
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_decision_log_ops_alert ON public.decision_log;
CREATE TRIGGER trg_decision_log_ops_alert
AFTER INSERT ON public.decision_log
FOR EACH ROW
EXECUTE FUNCTION public.log_ops_alert_from_decision();

-- Trigger function: on circuit_breaker_state changes
CREATE OR REPLACE FUNCTION public.log_provider_health_from_circuit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IN ('open','half_open') AND (OLD.state IS DISTINCT FROM NEW.state) THEN
    INSERT INTO public.provider_health_logs (
      provider_id,
      status,
      error_message,
      metadata,
      created_at
    )
    VALUES (
      NEW.provider_id,
      CASE WHEN NEW.state = 'open' THEN 'down' ELSE 'degraded' END,
      'circuit breaker ' || NEW.state,
      jsonb_build_object(
        'operation_name', NEW.operation_name,
        'failure_count', NEW.failure_count,
        'success_count', NEW.success_count
      ),
      now()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_circuit_breaker_health ON public.circuit_breaker_state;
CREATE TRIGGER trg_circuit_breaker_health
AFTER UPDATE ON public.circuit_breaker_state
FOR EACH ROW
EXECUTE FUNCTION public.log_provider_health_from_circuit();

COMMIT;
