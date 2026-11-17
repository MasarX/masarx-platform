-- Migration: HTTP response validation trigger fix
-- Purpose: Ensure decision_log_http_validation_trg resolves the webhook ingest
--          policy resolver function robustly by schema-qualifying the call.
-- Context:
--   - Parent (mhln) and repo both define public.resolve_webhook_ingest_policy(UUID).
--   - Some fresh branch/projects reported "function resolve_webhook_ingest_policy(...)
--     does not exist" at runtime from the trigger, despite the function being present.
--   - This is likely due to search_path / resolution quirks. Qualifying the resolver
--     with schema eliminates the ambiguity and keeps behavior identical.

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
    -- Resolve policy using resolver (source ladder-aware).
    -- Schema-qualify to avoid any search_path ambiguity on fresh environments.
    SELECT p.policy
      INTO v_policy
      FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_scope_id) AS p
      LIMIT 1;
  END IF;

  v_schema_id := NULLIF(
                    COALESCE(
                      v_policy#>>'{validation,json_schema_id}',
                      v_policy#>>'{ack,validation,json_schema_id}'
                    ),
                    ''
                );
  IF v_schema_id IS NOT NULL THEN
    NEW.decision_inputs := jsonb_strip_nulls(
      v_inputs || jsonb_build_object(
        'validation_results',
        COALESCE(v_inputs->'validation_results','{}'::jsonb) ||
        jsonb_build_object(
          'json_schema',
          jsonb_build_object('status','skipped','schema_id', v_schema_id)
        )
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Preserve explicit search_path for the trigger function.
ALTER FUNCTION public.decision_log_http_validation_trg()
  SET search_path = public, extensions, pg_temp;

COMMIT;

