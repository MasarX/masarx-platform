-- Migration: HTTP response validation trigger policy fix
-- Purpose:
--   - Ensure decision_log_http_validation_trg derives the webhook ingest policy
--     from the canonical settings row captured at intake (policy_settings_id)
--     instead of re-resolving by policy_scope_id as if it were a webhook_source.
--   - This avoids invalid resolver calls (e.g., passing a client_id to
--     resolve_webhook_ingest_policy) while keeping behaviour fully
--     configuration-driven and ladder-aware.

BEGIN;

CREATE OR REPLACE FUNCTION public.decision_log_http_validation_trg()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_has_validation boolean := FALSE;
  v_inputs jsonb := COALESCE(NEW.decision_inputs, '{}'::jsonb);
  v_webhook_id uuid;
  v_policy jsonb := '{}'::jsonb;
  v_schema_id text;
  v_scope_type text;
  v_scope_id uuid;
  v_settings_id uuid;
  v_webhook_source_id uuid;
BEGIN
  IF NEW.resource_type <> 'webhook_inbox'
     OR NEW.decision_category <> 'http_response_emitted' THEN
    RETURN NEW;
  END IF;

  v_has_validation :=
    (v_inputs ? 'validation_results')
    AND ((v_inputs->'validation_results') ? 'json_schema');
  IF v_has_validation THEN
    RETURN NEW;
  END IF;

  v_webhook_id := NEW.resource_id;
  SELECT webhook_source_id,
         policy_scope_type,
         policy_scope_id,
         policy_settings_id
    INTO v_webhook_source_id,
         v_scope_type,
         v_scope_id,
         v_settings_id
  FROM public.webhook_inbox
  WHERE id = v_webhook_id;

  -- Prefer the policy captured at intake (single source of truth).
  IF v_settings_id IS NOT NULL THEN
    SELECT s.cached_value
      INTO v_policy
      FROM public.settings AS s
      WHERE s.id = v_settings_id
        AND s.category = 'webhook_ingest_policy';
  ELSIF v_webhook_source_id IS NOT NULL THEN
    -- Fallback: resolve again using the webhook source id when the
    -- settings pointer is missing (defensive path for legacy rows).
    SELECT p.policy
      INTO v_policy
      FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_webhook_source_id) AS p
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
      v_inputs
      || jsonb_build_object(
        'validation_results',
        COALESCE(v_inputs->'validation_results', '{}'::jsonb)
        || jsonb_build_object(
          'json_schema',
          jsonb_build_object(
            'status', 'skipped',
            'schema_id', v_schema_id
          )
        )
      )
    );
  END IF;

  RETURN NEW;
END;
$function$;

-- Preserve explicit search_path for the trigger function.
ALTER FUNCTION public.decision_log_http_validation_trg()
  SET search_path = public, extensions, pg_temp;

COMMIT;

