-- Keep the receiving checkpoint executor and add a scoped readback for retries.
BEGIN;
SET LOCAL lock_timeout = '30s';

DO $migration$
DECLARE
  v_definition text;
  v_anchor text;
  v_declarations text := $$DECLARE
  v_user_id UUID := auth.uid();$$;
  v_mutation_start text := $$  CASE p_action_key
    WHEN 'warehouse_transfers.scan_departure' THEN$$;
  v_transition_start text := $$  SELECT task_event_id
    INTO v_task_event_id$$;
  v_readback_start text := $$  SELECT *
    INTO v_transfer_after$$;
  v_replay text := $$  <<checkpoint_mutation>>
  BEGIN
  <<checkpoint_replay>>
  BEGIN
    v_barcode := NULLIF(btrim(v_params->>'barcode'), '');
    IF p_resource_key <> 'warehouse_transfers'
       OR v_visible_transfer->>'id' IS DISTINCT FROM v_transfer.id::text
       OR v_capability IS NULL
       OR p_action_key NOT IN ('warehouse_transfers.scan_departure', 'warehouse_transfers.scan_arrival')
       OR v_barcode IS NULL THEN
      EXIT checkpoint_replay;
    END IF;

    v_phase_key := CASE p_action_key WHEN 'warehouse_transfers.scan_departure' THEN 'dispatch' ELSE 'receive' END;
    v_checkpoint_key := CASE v_phase_key WHEN 'dispatch' THEN 'load' ELSE 'unload' END;
    v_task_type_key := CASE v_phase_key WHEN 'dispatch' THEN 'warehouse_transfer_dispatch' ELSE 'warehouse_transfer_receive' END;
    v_branch_id := CASE v_phase_key WHEN 'dispatch' THEN v_transfer.from_branch_id ELSE v_transfer.to_branch_id END;
    v_handling_unit_code := NULLIF(btrim(v_params->>'handling_unit_code'), '');
    v_notes := NULLIF(btrim(v_params->>'notes'), '');

    BEGIN
      v_branch_id := COALESCE(NULLIF(btrim(v_params->>'branch_id'), '')::uuid, v_branch_id);
      v_device_id := NULLIF(btrim(v_params->>'device_id'), '')::uuid;
      v_ops_session_id := NULLIF(btrim(v_params->>'ops_session_id'), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      -- Let the original mutation raise its field-specific validation error.
      EXIT checkpoint_replay;
    END;

    SELECT t.id AS task_id, te.id AS task_event_id, se.id AS scan_event_id,
           wr.id AS workflow_run_id, wr.workflow_status
      INTO v_replay
      FROM public.tasks t
      JOIN public.task_types tt ON tt.id = t.task_type_id
      JOIN public.task_events te ON te.task_id = t.id AND te.organization_id = t.organization_id
      JOIN public.scan_event_dedupe dedupe
        ON dedupe.organization_id = te.organization_id AND dedupe.idempotency_key = te.idempotency_key
      JOIN public.scan_events se
        ON se.id = dedupe.scan_event_id
       AND se.id::text = te.payload->>'scan_event_id'
       AND se.organization_id = t.organization_id
       AND se.warehouse_transfer_id = t.resource_id
      -- The enqueue handler records the transfer workflow as the task's parent.
      JOIN public.workflow_runs wr ON wr.id::text = t.metadata->>'parent_workflow_run_id'
      JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id
     WHERE t.organization_id = v_transfer.organization_id
       AND t.resource_type = 'warehouse_transfer'
       AND t.resource_id = v_transfer.id
       AND tt.key = v_task_type_key
       AND wt.name = 'warehouse_transfer_execute_v1'
       AND wr.context->>'warehouse_transfer_id' = v_transfer.id::text
       AND COALESCE(wr.context->>'organization_id', t.organization_id::text) = t.organization_id::text
       AND te.to_status = 'completed'
       AND te.actor_user_id = v_user_id
       -- Browser callers omit the key. Recompute the mutation default using the completed task.
       AND te.idempotency_key = COALESCE(
         NULLIF(btrim(v_params->>'idempotency_key'), ''),
         concat_ws(
           ':', 'warehouse_transfer_checkpoint_ui_v1', p_action_key, v_transfer.id::text, t.id::text,
           lower(v_barcode), COALESCE(lower(v_handling_unit_code), ''),
           COALESCE(v_branch_id::text, ''), COALESCE(v_device_id::text, ''), COALESCE(v_ops_session_id::text, '')
         )
       )
       AND te.payload->>'scan_created' = 'true'
       AND te.payload->>'phase' = v_phase_key
       AND te.payload->>'checkpoint_key' = v_checkpoint_key
       AND te.payload->>'barcode' = v_barcode
       AND te.payload->>'handling_unit_code' IS NOT DISTINCT FROM v_handling_unit_code
       AND te.payload->>'notes' IS NOT DISTINCT FROM v_notes
       AND te.payload->>'branch_id' IS NOT DISTINCT FROM v_branch_id::text
       AND te.payload->>'device_id' IS NOT DISTINCT FROM v_device_id::text
       AND te.ops_session_id IS NOT DISTINCT FROM v_ops_session_id
       AND se.actor_user_id = v_user_id
       AND se.idempotency_key = te.idempotency_key
       AND se.scan_type = 'warehouse_checkpoint'
       AND se.checkpoint_key = v_checkpoint_key
       AND se.barcode = v_barcode
       AND se.branch_id IS NOT DISTINCT FROM v_branch_id
       AND se.device_id IS NOT DISTINCT FROM v_device_id
       AND se.ops_session_id IS NOT DISTINCT FROM te.ops_session_id
       AND se.metadata->>'action_key' = p_action_key
       AND se.metadata->>'task_id' = t.id::text
       AND (se.metadata - v_system_scan_fields) = (jsonb_strip_nulls(v_meta) - v_system_scan_fields)
       AND (v_notes IS NOT NULL OR se.metadata->'notes' IS NOT DISTINCT FROM jsonb_strip_nulls(v_meta)->'notes')
       AND (se.device_id IS NULL OR EXISTS (
         SELECT 1 FROM public.user_devices d
          WHERE d.id = se.device_id
            AND d.organization_id = se.organization_id
            AND d.user_id = v_user_id
            AND d.revoked_at IS NULL
       ))
     ORDER BY te.created_at DESC, te.id
     LIMIT 1;

    IF FOUND THEN
      v_task.id := v_replay.task_id;
      v_task_event_id := v_replay.task_event_id;
      v_scan_event_id := v_replay.scan_event_id;
      v_workflow_run_id := v_replay.workflow_run_id;
      v_existing_workflow_status := v_replay.workflow_status;
      EXIT checkpoint_mutation;
    END IF;
  END checkpoint_replay;

$$;
  v_key_conflict text := $$  IF NOT v_scan_created THEN
    RAISE EXCEPTION 'Warehouse checkpoint idempotency key belongs to another scan' USING ERRCODE = '23514';
  END IF;

$$;
BEGIN
  v_definition := pg_get_functiondef(
    'public.ui_execute_warehouse_transfer_checkpoint_v1(text,text,text[],text,integer,jsonb)'::regprocedure
  );

  IF position('v_elevated_claims' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected receiving warehouse checkpoint executor';
  END IF;
  FOREACH v_anchor IN ARRAY ARRAY[v_declarations, v_mutation_start, v_transition_start, v_readback_start]
  LOOP
    IF cardinality(string_to_array(v_definition, v_anchor)) IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'Expected one warehouse checkpoint executor anchor: %', v_anchor;
    END IF;
  END LOOP;

  v_definition := replace(v_definition, v_declarations,
    replace(v_declarations, 'DECLARE', $$DECLARE
  v_replay RECORD;
  v_system_scan_fields CONSTANT TEXT[] := ARRAY[
    'source', 'action_key', 'phase', 'warehouse_transfer_id', 'task_id', 'notes',
    'checkpoint_key', 'checkpoint_sequence', 'checkpoint_scope', 'decision_log_id',
    -- tg_enforce_mobile_attestation_ingest_v1 also overwrites these keys on insert.
    'app', '__attestation_source'
  ];$$));
  v_definition := replace(v_definition, v_mutation_start, v_replay || v_mutation_start);
  v_definition := replace(v_definition, v_transition_start, v_key_conflict || v_transition_start);
  v_definition := replace(v_definition, v_readback_start,
    E'  END checkpoint_mutation;\n\n' || v_readback_start);
  EXECUTE v_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-- The API wrapper already supplies a managed scanner. Keep the ops-session field for scoped policy overrides.
DO $form$
DECLARE
  v_row RECORD;
  v_commands JSONB;
BEGIN
  FOR v_row IN
    SELECT s.category, s.scope_type, s.scope_id, sv.schema_version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_command_registry'
       AND jsonb_typeof(sv.value->'commands') = 'array'
     FOR UPDATE OF s, sv
  LOOP
    SELECT COALESCE(jsonb_agg(
      CASE WHEN command->>'key' IN ('warehouse_transfers.scan_departure', 'warehouse_transfers.scan_arrival')
             AND command#>>'{execution,rpc}' = 'ui_execute_warehouse_transfer_checkpoint_v1'
             AND jsonb_typeof(command#>'{execution,input_schema,fields}') = 'array'
           THEN jsonb_set(command, '{execution,input_schema,fields}', (
             SELECT COALESCE(jsonb_agg(field ORDER BY field_order), '[]'::jsonb)
               FROM jsonb_array_elements(command#>'{execution,input_schema,fields}')
                 WITH ORDINALITY AS fields(field, field_order)
              WHERE field->>'key' IS DISTINCT FROM 'device_id'
           ), FALSE)
           ELSE command END ORDER BY command_order
    ), '[]'::jsonb)
      INTO v_commands
      FROM jsonb_array_elements(v_row.value->'commands') WITH ORDINALITY AS commands(command, command_order);

    IF v_commands IS DISTINCT FROM v_row.value->'commands' THEN
      PERFORM public.upsert_settings_value_v1(
        v_row.category, v_row.scope_type, v_row.scope_id,
        jsonb_set(v_row.value, '{commands}', v_commands, FALSE), v_row.schema_version,
        'Use the managed scanner for warehouse checkpoint commands.');
    END IF;
  END LOOP;

  DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_command_registry:%';
END;
$form$;

COMMIT;
