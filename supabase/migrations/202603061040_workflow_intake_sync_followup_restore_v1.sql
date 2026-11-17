-- Purpose: restore workflow_intake_webhook sync_only follow-up execution without
-- re-copying the full hardened intake core.

DO $$
BEGIN
  IF to_regprocedure('public.workflow_intake_webhook_core_v1(text, jsonb, text, jsonb)') IS NULL
     AND to_regprocedure('public.workflow_intake_webhook(text, jsonb, text, jsonb)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB) RENAME TO workflow_intake_webhook_core_v1';
  END IF;
END;
$$;

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
BEGIN
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
IS 'Canonical webhook intake wrapper. Restores sync_only inline follow-up execution on top of the hardened intake core.';

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
