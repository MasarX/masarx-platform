-- Keep dedicated dispatch-exception RPC inputs at the top level of p_params.
-- The commands were derived from tasks.complete, whose payload wrapper is not
-- compatible with ui_execute_dispatch_exception_resolution_v1.

DO $do$
DECLARE
  v_target_keys CONSTANT TEXT[] := ARRAY[
    'dispatch_exception_review.complete',
    'dispatch_exception_review_mine.complete',
    'sla_deadline_alerts.complete'
  ];
  v_execution CONSTANT JSONB := jsonb_build_object(
    'type', 'rpc',
    'rpc', 'ui_execute_dispatch_exception_resolution_v1',
    'input_schema', jsonb_build_object(
      'version', 1,
      'title', 'Resolve dispatch exception',
      'description', 'Choose a policy-backed resolution action and optional notes.',
      'fields', jsonb_build_array(
        jsonb_build_object(
          'key', 'resolution_action',
          'label', 'Resolution action',
          'type', 'lookup',
          'lookup_category', 'ndr_action',
          'required', TRUE,
          'placeholder', 'Select a resolution action'
        ),
        jsonb_build_object(
          'key', 'resolution_notes',
          'label', 'Resolution notes',
          'type', 'textarea',
          'required', FALSE,
          'placeholder', 'Optional notes'
        )
      )
    )
  );
  v_row RECORD;
  v_current JSONB;
  v_commands JSONB;
  v_next_commands JSONB;
  v_command JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
        FROM jsonb_array_elements(v_commands) AS value
    LOOP
      IF COALESCE(v_command->>'key', '') = ANY (v_target_keys) THEN
        v_command := jsonb_set(v_command, '{execution}', v_execution, TRUE);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    v_current := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);
    IF v_current IS NOT DISTINCT FROM v_row.value THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_row.version + 1,
           change_reason = 'Keep dispatch exception resolution inputs top-level for the dedicated RPC.',
           approved_at = workflow_now(),
           effective_from = workflow_now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = workflow_now()
     WHERE id = v_row.settings_id;
  END LOOP;
END;
$do$;
