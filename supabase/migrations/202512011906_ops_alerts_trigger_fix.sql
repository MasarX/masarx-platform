-- Migration: Fix ops alerts trigger to clamp created_at within current partitions

BEGIN;

CREATE OR REPLACE FUNCTION public.log_ops_alert_from_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_created_at timestamptz;
BEGIN
  v_created_at := COALESCE(NEW."timestamp", now());
  IF v_created_at < date_trunc('month', now()) THEN
    v_created_at := date_trunc('month', now());
  END IF;

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
      v_created_at
    );
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
