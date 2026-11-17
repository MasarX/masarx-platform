-- Migration: Fix ops_alerts trigger semantics (2xx should not page) — fixup
-- Context: A prior timestamp collision caused the correct semantics migration to be skipped in cloud history.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_ops_alert_from_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_created_at timestamptz;
  v_status_text text;
  v_status int;
BEGIN
  IF NEW.decision_category <> 'http_response_emitted'
     OR NEW.resource_type <> 'webhook_inbox' THEN
    RETURN NEW;
  END IF;

  v_status_text := NULLIF(NEW.decision_inputs->>'status', '');
  v_status := CASE
    WHEN v_status_text ~ '^[0-9]+$' THEN v_status_text::int
    ELSE NULL
  END;

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

