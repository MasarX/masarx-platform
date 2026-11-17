-- Purpose: restore fail-closed missing entry-template behavior for webhook intake
-- without reverting hardened core validation/idempotency logic.

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(
  p_token TEXT,
  p_headers JSONB,
  p_raw_body TEXT,
  p_payload JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_result JSONB;
  v_followup_run_id UUID := NULL;
  v_source_id UUID := NULL;
  v_policy_row RECORD;
  v_policy_body JSONB := '{}'::jsonb;
  v_launch_mode TEXT := 'in_background';
  v_source_row RECORD;
  v_intake_settings JSONB := '{}'::jsonb;
  v_defaults JSONB := '{}'::jsonb;
  v_error_status INT := 500;
BEGIN
  -- Fail closed on missing intake entry template before request-level validation
  -- paths (for example idempotency), preserving dynamic error_status contract.
  IF p_token IS NOT NULL AND btrim(p_token) <> '' THEN
    BEGIN
      SELECT *
        INTO v_source_row
        FROM public.get_webhook_source_by_token(p_token)
       LIMIT 1;

      IF v_source_row.id IS NOT NULL AND v_source_row.enabled IS TRUE THEN
        v_intake_settings := public.resolve_settings('webhook_intake', 'tenant', v_source_row.organization_id);
        IF v_intake_settings IS NULL THEN
          v_intake_settings := public.resolve_settings('webhook_intake', 'global', NULL);
        END IF;

        v_defaults := COALESCE(v_intake_settings->'defaults', '{}'::jsonb);
        BEGIN
          v_error_status := COALESCE(NULLIF(v_defaults->>'error_status', '')::INT, 500);
        EXCEPTION
          WHEN others THEN
            v_error_status := 500;
        END;

        IF NULLIF(v_intake_settings->>'entry_template_id', '') IS NULL THEN
          RETURN jsonb_build_object(
            'status', v_error_status,
            'headers', jsonb_build_object('content-type', 'application/json'),
            'body', jsonb_build_object('error', 'Webhook intake entry template not configured'),
            'ack_outcome', 'ack_failed',
            'response_outcome', 'response_failed',
            'response_mode', 'accepted_async',
            'response_reason', 'missing_entry_template'
          );
        END IF;
      END IF;
    EXCEPTION
      WHEN others THEN
        -- Preserve canonical behavior for auth/error paths handled in core.
        NULL;
    END;
  END IF;

  v_result := public.workflow_intake_webhook_core_v1(
    p_token,
    p_headers,
    p_raw_body,
    p_payload
  );

  BEGIN
    v_followup_run_id := NULLIF(v_result->>'followup_workflow_run_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_followup_run_id := NULL;
  END;

  IF v_followup_run_id IS NOT NULL THEN
    SELECT id
      INTO v_source_id
      FROM public.get_webhook_source_by_token(p_token)
      LIMIT 1;
  END IF;

  IF v_followup_run_id IS NOT NULL AND v_source_id IS NOT NULL THEN
    BEGIN
      SELECT *
        INTO v_policy_row
        FROM public.resolve_webhook_ingest_policy(p_webhook_source_id := v_source_id)
       LIMIT 1;

      v_policy_body := COALESCE(v_policy_row.policy, '{}'::jsonb);
      v_launch_mode := COALESCE(
        NULLIF(v_policy_body#>>'{workflow,launch_mode}', ''),
        'in_background'
      );

      IF v_launch_mode = 'sync_only' THEN
        IF EXISTS (
          SELECT 1
          FROM public.workflow_run_steps wrs
          WHERE wrs.workflow_run_id = v_followup_run_id
            AND wrs.step_status = 'pending'
            AND COALESCE(wrs.run_at, now()) <= now()
        ) THEN
          PERFORM public.progress_workflow_run(v_followup_run_id);
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM public.workflow_run_steps wrs
          WHERE wrs.workflow_run_id = v_followup_run_id
            AND wrs.step_status = 'pending'
        ) THEN
          PERFORM public.progress_workflow_run(v_followup_run_id);
        END IF;

        v_result := jsonb_set(v_result, '{followup_sync}', to_jsonb(TRUE), TRUE);
      END IF;
    EXCEPTION
      WHEN others THEN
        v_result := jsonb_set(v_result, '{followup_sync_error}', to_jsonb(SQLERRM), TRUE);
    END;
  END IF;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
IS 'Canonical webhook intake wrapper. Restores missing-template fail-closed precedence and sync_only inline follow-up execution on top of hardened intake core.';

REVOKE EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'edge_webhook_role'
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) TO edge_webhook_role';
  END IF;
END;
$$;
