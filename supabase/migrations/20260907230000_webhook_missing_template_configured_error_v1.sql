-- Preserve configured missing-template errors without restoring an obsolete core.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, extensions, pg_temp;
DO $repair$
DECLARE
  v_def TEXT;
  v_old TEXT := $old$
  IF v_entry_template_id IS NULL THEN
    v_entry_template_id := '77770000-0000-0000-0000-000000770001'::UUID;
  END IF;
$old$;
  v_new TEXT := $new$
  IF v_entry_template_id IS NULL THEN
    -- Source token/enabled and policy admission have already passed.
    RETURN jsonb_build_object(
      'correlation_id', v_correlation_id,
      'status', COALESCE(NULLIF(v_defaults->>'error_status', '')::INT, 500),
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object('error', 'Webhook intake entry template is not configured'),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', 'accepted_async',
      'response_reason', 'missing_entry_template'
    );
  END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure) INTO v_def;
  IF v_def IS NULL OR
     (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'Unexpected workflow_intake_webhook_core_v1 missing-template definition shape';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END;
$repair$;
COMMIT;
