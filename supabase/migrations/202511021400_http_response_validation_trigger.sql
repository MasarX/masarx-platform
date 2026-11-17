-- Migration: HTTP response validation enrichment trigger
-- Purpose: Ensure decision_log.http_response_emitted includes validation_results.json_schema
--          when a schema is configured but not propagated via context.

BEGIN;

CREATE OR REPLACE FUNCTION public.decision_log_http_validation_trg()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_validation boolean := FALSE;
  v_inputs jsonb := COALESCE(NEW.decision_inputs, '{}'::jsonb);
  v_webhook_id uuid;
  v_policy jsonb := '{}'::jsonb;
  v_schema_id text;
  v_scope_type text;
  v_scope_id uuid;
  v_settings_id uuid;
BEGIN
  IF NEW.resource_type <> 'webhook_inbox' OR NEW.decision_category <> 'http_response_emitted' THEN
    RETURN NEW;
  END IF;

  v_has_validation := (v_inputs ? 'validation_results')
                      AND ((v_inputs->'validation_results') ? 'json_schema');
  IF v_has_validation THEN
    RETURN NEW;
  END IF;

  v_webhook_id := NEW.resource_id;
  SELECT policy_scope_type, policy_scope_id, policy_settings_id
    INTO v_scope_type, v_scope_id, v_settings_id
  FROM public.webhook_inbox
  WHERE id = v_webhook_id;

  IF v_scope_type IS NOT NULL AND v_scope_id IS NOT NULL THEN
    -- resolve policy using resolver (source ladder-aware)
    SELECT p.policy
    INTO v_policy
    FROM resolve_webhook_ingest_policy(p_webhook_source_id := v_scope_id) AS p
    LIMIT 1;
  END IF;

  v_schema_id := NULLIF(COALESCE(v_policy#>>'{validation,json_schema_id}', v_policy#>>'{ack,validation,json_schema_id}'), '');
  IF v_schema_id IS NOT NULL THEN
    NEW.decision_inputs := jsonb_strip_nulls(
      v_inputs || jsonb_build_object(
        'validation_results',
        COALESCE(v_inputs->'validation_results','{}'::jsonb) ||
        jsonb_build_object('json_schema', jsonb_build_object('status','skipped','schema_id', v_schema_id))
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.decision_log_http_validation_trg()
  SET search_path = public, extensions, pg_temp;

-- Create trigger only if missing to avoid lock churn on busy tables
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'decision_log' AND t.tgname = 'decision_log_http_validation'
  ) THEN
    CREATE TRIGGER decision_log_http_validation
      BEFORE INSERT ON public.decision_log
      FOR EACH ROW
      EXECUTE FUNCTION public.decision_log_http_validation_trg();
  END IF;
END $$;

COMMIT;
