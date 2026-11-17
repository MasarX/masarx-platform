-- Migration: Fix ops_alerts trigger semantics (2xx should not page)

BEGIN;

CREATE OR REPLACE FUNCTION public.log_ops_alert_from_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_created_at timestamptz;
  v_status int;
BEGIN
  IF NEW.decision_category <> 'http_response_emitted'
     OR NEW.resource_type <> 'webhook_inbox' THEN
    RETURN NEW;
  END IF;

  v_status := NULLIF(NEW.decision_inputs->>'status', '')::int;

  IF v_status IS NOT NULL AND v_status BETWEEN 200 AND 299 THEN
    RETURN NEW;
  END IF;

  v_created_at := COALESCE(NEW."timestamp", now());
  IF v_created_at < date_trunc('month', now()) THEN
    v_created_at := date_trunc('month', now());
  END IF;

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
    COALESCE(
      NEW.decision_reason,
      format('Webhook ACK failure (status=%s)', COALESCE(v_status::text, 'unknown'))
    ),
    NEW.decision_inputs,
    NEW.id,
    NEW.correlation_id,
    v_created_at
  );

  RETURN NEW;
END;
$$;

COMMIT;

