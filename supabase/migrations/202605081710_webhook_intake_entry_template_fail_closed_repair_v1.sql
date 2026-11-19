-- Console V2 first-tenant readiness: webhook intake must be row-driven.
--
-- Repair the current workflow_intake_webhook_core_v1 body so a missing
-- webhook_intake.entry_template_id fails closed instead of falling back to a
-- literal workflow template UUID. The normal runtime still succeeds because
-- shared/local settings carry the configured entry_template_id row.

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_def TEXT;
  v_before TEXT := $old$
  v_entry_template_id := NULLIF(v_intake_settings->>'entry_template_id', '')::UUID;
  IF v_entry_template_id IS NULL THEN
    v_entry_template_id := '77770000-0000-0000-0000-000000770001'::UUID;
  END IF;
$old$;
  v_after TEXT := $new$
  v_entry_template_id := NULLIF(v_intake_settings->>'entry_template_id', '')::UUID;
  IF v_entry_template_id IS NULL THEN
    v_ack_reason := 'webhook_intake entry_template_id not configured';
    RETURN jsonb_build_object(
      'status', COALESCE((v_defaults->>'error_status')::INT, 500),
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', v_ack_reason),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', 'accepted_async'
    );
  END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 definition not found';
  END IF;

  IF position(v_before IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected hardcoded entry_template_id fallback not found in workflow_intake_webhook_core_v1';
  END IF;

  v_def := replace(v_def, v_before, v_after);

  IF position(v_before IN v_def) <> 0 THEN
    RAISE EXCEPTION 'Failed to remove hardcoded entry_template_id fallback from workflow_intake_webhook_core_v1';
  END IF;

  EXECUTE v_def;
END;
$$;

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(text, jsonb, text, jsonb) IS
  'Core webhook intake entrypoint. Fails closed when webhook_intake.entry_template_id is missing; workflow template selection is row-driven through settings and source policy.';

COMMIT;
