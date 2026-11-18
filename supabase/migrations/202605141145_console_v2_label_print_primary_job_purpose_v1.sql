-- Console V2 print-label commands are primary print requests.
--
-- Explicit reprints remain governed by request_label_reprint. The generic
-- labels_print_workflow_v2 path must carry the command's job_purpose through to
-- label-renderer so a first label generated from the shipment drawer is not
-- shown or persisted as a reprint.

DO $$
DECLARE
  v_def text;
  v_next text;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.execute_label_print_execute_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
  )
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'workflow_handlers.execute_label_print_execute_v1 is missing';
  END IF;

  IF v_def NOT LIKE '%v_print_mode text := ''print_sync'';%' THEN
    RAISE EXCEPTION 'label print execute declaration anchor not found';
  END IF;

  v_next := replace(
    v_def,
    '  v_print_mode text := ''print_sync'';
  v_artifact_kind text := NULL;',
    '  v_print_mode text := ''print_sync'';
  v_job_purpose text := ''primary'';
  v_artifact_kind text := NULL;'
  );

  IF v_next NOT LIKE '%v_options := COALESCE(v_label_state->''options'', v_payload->''options'', ''{}''::jsonb);%' THEN
    RAISE EXCEPTION 'label print execute options anchor not found';
  END IF;

  v_next := replace(
    v_next,
    '  v_options := COALESCE(v_label_state->''options'', v_payload->''options'', ''{}''::jsonb);
  v_client_id := NULLIF(COALESCE(v_label_state->>''client_id'', v_payload->>''client_id''), '''');',
    '  v_options := COALESCE(v_label_state->''options'', v_payload->''options'', ''{}''::jsonb);
  v_job_purpose := lower(COALESCE(
    NULLIF(v_options->>''job_purpose'', ''''),
    NULLIF(v_payload->>''job_purpose'', ''''),
    NULLIF(v_context #>> ''{ui_command,params,job_purpose}'', ''''),
    ''primary''
  ));
  IF v_job_purpose NOT IN (''primary'', ''reprint'', ''manual'') THEN
    v_job_purpose := ''primary'';
  END IF;
  v_client_id := NULLIF(COALESCE(v_label_state->>''client_id'', v_payload->>''client_id''), '''');'
  );

  IF v_next NOT LIKE '%''execute_wait_poll_ms'', v_execute_wait_poll_ms,%' THEN
    RAISE EXCEPTION 'label print execute payload anchor not found';
  END IF;

  v_next := replace(
    v_next,
    '        ''execute_wait_poll_ms'', v_execute_wait_poll_ms,
        ''metadata'', jsonb_strip_nulls(',
    '        ''execute_wait_poll_ms'', v_execute_wait_poll_ms,
        ''job_purpose'', v_job_purpose,
        ''metadata'', jsonb_strip_nulls('
  );

  EXECUTE v_next;
END $$;

COMMENT ON FUNCTION workflow_handlers.execute_label_print_execute_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Executes Console V2 label print workflow and carries explicit command job_purpose to label-renderer; first print uses primary while reprints stay on request_label_reprint.';
