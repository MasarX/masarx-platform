-- Plan: PLAN-202512-verify-integration-drift-fix / Step: S03
-- Migration: workflow_intake_webhook sync_only follow-up fixup
-- Purpose:
--   - Re-assert the canonical workflow_intake_webhook() definition that supports
--     webhook_ingest_policy.workflow.launch_mode='sync_only' (inline follow-up execution).
--   - Fixes drift for long-lived preview/staging databases that may have applied an
--     older revision of the function before the sync follow-up logic existed.
-- Date: 2025-12-24

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.workflow_intake_webhook(
  p_token   text,
  p_headers jsonb,
  p_raw_body text,
  p_payload jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result           jsonb;
  v_org_id           uuid;
  v_source_id        uuid;
  v_defaults         jsonb;
  v_status           int;
  v_status_async     int;
  v_status_error     int;
  v_workflow_run_id  uuid;
  v_ack_outcome      text;
  v_intake_settings  jsonb;
  v_has_entry_template boolean := true;
  v_template_missing_reason CONSTANT text := 'webhook_intake entry_template_id not configured';

  -- Sync follow-up fast path (policy-driven)
  v_followup_run_id uuid := NULL;
  v_policy_row RECORD;
  v_policy_body jsonb := '{}'::jsonb;
  v_launch_mode text := 'in_background';
BEGIN
  -- Delegate actual intake work to the core implementation.
  v_result := public.workflow_intake_webhook_core(p_token, p_headers, p_raw_body, p_payload);

  -- Derive organization id + source id from token so we can resolve defaults/policy.
  BEGIN
    SELECT id, organization_id
      INTO v_source_id, v_org_id
      FROM get_webhook_source_by_token(p_token)
     LIMIT 1;
  EXCEPTION
    WHEN others THEN
      v_source_id := NULL;
      v_org_id := NULL;
  END;

  IF v_org_id IS NOT NULL THEN
    -- Defaults (accepted_async_status, error_status, etc.)
    v_defaults := resolve_webhook_intake_defaults(v_org_id);
    v_status_async := (v_defaults->>'accepted_async_status')::int;
    v_status_error := (v_defaults->>'error_status')::int;

    -- Full intake settings so we can detect missing entry_template_id.
    v_intake_settings := resolve_settings('webhook_intake', 'tenant', v_org_id);
    IF v_intake_settings IS NULL THEN
      v_intake_settings := resolve_settings('webhook_intake', 'global', NULL);
    END IF;
    v_has_entry_template :=
      COALESCE(NULLIF(v_intake_settings->>'entry_template_id', ''), '') <> '';
  ELSE
    v_defaults := NULL;
    v_status_async := NULL;
    v_status_error := NULL;
    v_intake_settings := NULL;
    v_has_entry_template := true;
  END IF;

  v_status := COALESCE((v_result->>'status')::int, 0);
  v_workflow_run_id := NULLIF(v_result->>'workflow_run_id', '')::uuid;
  v_ack_outcome := COALESCE(v_result->>'ack_outcome', '');

  -- When no workflow_run_id is recorded OR the intake settings have no
  -- entry_template_id configured, and the core returned the accepted_async
  -- status for a successful ack, treat this as a misconfigured workflow
  -- template and upgrade the status to the dynamic error_status from defaults.
  IF v_defaults IS NOT NULL
     AND v_ack_outcome = 'ack_sent'
     AND v_status_async IS NOT NULL
     AND v_status = v_status_async
     AND (v_workflow_run_id IS NULL OR NOT v_has_entry_template) THEN
    -- Upgrade status and annotate response metadata.
    v_result := jsonb_set(
      v_result,
      '{status}',
      to_jsonb(COALESCE(v_status_error, v_status))
    );

    v_result := jsonb_set(
      v_result,
      '{response_outcome}',
      to_jsonb('response_failed'::text)
    );

    v_result := jsonb_set(
      v_result,
      '{response_reason}',
      to_jsonb('workflow_template_missing'::text)
    );

    -- Provide a stable error message while preserving any existing body shape.
    v_result := jsonb_set(
      v_result,
      '{body}',
      COALESCE(
        (v_result->'body') || jsonb_build_object('error', 'Webhook workflow template not configured'),
        jsonb_build_object('error', 'Webhook workflow template not configured')
      )
    );
  END IF;

  -- If the core flagged a missing entry_template_id, upgrade to error_status
  -- even when the ack_outcome is already ack_failed (pre-HMAC).
  IF v_defaults IS NOT NULL
     AND v_ack_outcome = 'ack_failed'
     AND COALESCE(v_result->>'response_reason', v_result->>'ack_reason', '') = v_template_missing_reason THEN
    v_result := jsonb_set(
      v_result,
      '{status}',
      to_jsonb(COALESCE(v_status_error, v_status))
    );
    v_result := jsonb_set(
      v_result,
      '{response_outcome}',
      to_jsonb('response_failed'::text)
    );
    v_result := jsonb_set(
      v_result,
      '{response_reason}',
      to_jsonb('workflow_template_missing'::text)
    );
  END IF;

  -- Policy-driven follow-up fast path: launch_mode=sync_only.
  BEGIN
    v_followup_run_id := NULLIF(v_result->>'followup_workflow_run_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_followup_run_id := NULL;
  END;

  IF v_followup_run_id IS NOT NULL AND v_source_id IS NOT NULL THEN
    BEGIN
      SELECT *
        INTO v_policy_row
        FROM resolve_webhook_ingest_policy(p_webhook_source_id := v_source_id)
       LIMIT 1;

      v_policy_body := COALESCE(v_policy_row.policy, '{}'::jsonb);
      v_launch_mode := COALESCE(NULLIF(v_policy_body#>>'{workflow,launch_mode}', ''), 'in_background');

      IF v_launch_mode = 'sync_only' THEN
        -- Only execute when a pending step is due; avoid running delayed steps early.
        IF EXISTS (
          SELECT 1
          FROM public.workflow_run_steps wrs
          WHERE wrs.workflow_run_id = v_followup_run_id
            AND wrs.step_status = 'pending'
            AND wrs.run_at <= now()
        ) THEN
          PERFORM public.progress_workflow_run(v_followup_run_id);
        END IF;

        -- Finalize run only when no pending steps remain (prevents early execution of delayed steps).
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
        -- Never block webhook intake on fast-path failures; worker will process later.
        v_result := jsonb_set(v_result, '{followup_sync_error}', to_jsonb(SQLERRM), TRUE);
    END;
  END IF;

  RETURN v_result;
END;
$function$;

COMMIT;
