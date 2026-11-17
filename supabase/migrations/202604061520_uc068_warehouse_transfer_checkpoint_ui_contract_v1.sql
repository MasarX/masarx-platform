-- Plan: PLAN-202604-b05-transfer-execution-surface / Step: S02
-- Migration: UC068 warehouse transfer checkpoint UI contract v1
-- Date: 2026-04-06
--
-- Goals:
--   - Expose browser-safe Portal/Console transfer departure and arrival scans.
--   - Keep transfer execution workflow-engine first by recording checkpoint scans,
--     completing the active workflow task, and waking public.progress_workflow_run.
--   - Reuse the canonical warehouse_transfer_execute_v1 workflow and existing
--     scan/task SSOT paths instead of widening generic command execution.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061520_uc068_warehouse_transfer_checkpoint_ui_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Dedicated UI executor for warehouse transfer departure/arrival scans
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_meta JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_visible_transfer JSONB := NULL;
  v_transfer public.warehouse_transfers%ROWTYPE;
  v_transfer_after public.warehouse_transfers%ROWTYPE;
  v_workflow_run_id UUID := NULL;
  v_existing_workflow_status TEXT := NULL;
  v_task public.tasks%ROWTYPE;
  v_task_type_key TEXT := NULL;
  v_checkpoint_key TEXT := NULL;
  v_phase_key TEXT := NULL;
  v_barcode TEXT := NULL;
  v_handling_unit_code TEXT := NULL;
  v_notes TEXT := NULL;
  v_branch_id UUID := NULL;
  v_device_id UUID := NULL;
  v_ops_session_id UUID := NULL;
  v_scan_idempotency_key TEXT := NULL;
  v_scan_event_id UUID := NULL;
  v_scan_created BOOLEAN := FALSE;
  v_task_event_id UUID := NULL;
  v_progress JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);
  IF jsonb_typeof(v_params) IS DISTINCT FROM 'object' THEN
    v_params := '{}'::jsonb;
  END IF;
  v_meta := COALESCE(v_params->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN
    v_meta := '{}'::jsonb;
  END IF;

  v_selection_id_text := COALESCE(
    NULLIF(v_id, ''),
    CASE WHEN array_length(v_ids, 1) IS NOT NULL THEN v_ids[1] ELSE NULL END
  );

  BEGIN
    v_selection_uuid := NULLIF(btrim(COALESCE(v_selection_id_text, '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_selection_uuid := NULL;
  END;

  IF v_selection_uuid IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 invalid warehouse_transfer id %', v_selection_id_text;
  END IF;

  v_visible_transfer := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
  IF v_visible_transfer IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 warehouse_transfer % is not visible in resource %', v_selection_uuid, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_transfer
    FROM public.warehouse_transfers wt
   WHERE wt.id = v_selection_uuid
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 warehouse_transfer % not found', v_selection_uuid
      USING ERRCODE = '23503';
  END IF;

  CASE p_action_key
    WHEN 'warehouse_transfers.scan_departure' THEN
      v_task_type_key := 'warehouse_transfer_dispatch';
      v_checkpoint_key := 'load';
      v_phase_key := 'dispatch';
      IF lower(COALESCE(v_transfer.status, '')) <> 'draft' THEN
        RAISE EXCEPTION
          'ui_execute_warehouse_transfer_checkpoint_v1 departure only supports draft warehouse_transfers (current status %)',
          v_transfer.status
          USING ERRCODE = '23514';
      END IF;
      v_branch_id := v_transfer.from_branch_id;
    WHEN 'warehouse_transfers.scan_arrival' THEN
      v_task_type_key := 'warehouse_transfer_receive';
      v_checkpoint_key := 'unload';
      v_phase_key := 'receive';
      IF lower(COALESCE(v_transfer.status, '')) <> 'in_transit' THEN
        RAISE EXCEPTION
          'ui_execute_warehouse_transfer_checkpoint_v1 arrival only supports in_transit warehouse_transfers (current status %)',
          v_transfer.status
          USING ERRCODE = '23514';
      END IF;
      v_branch_id := v_transfer.to_branch_id;
    ELSE
      RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 unsupported action key %', p_action_key;
  END CASE;

  SELECT wr.id, wr.workflow_status
    INTO v_workflow_run_id, v_existing_workflow_status
    FROM public.workflow_runs wr
    JOIN public.workflow_templates wt
      ON wt.id = wr.workflow_template_id
   WHERE wt.name = 'warehouse_transfer_execute_v1'
     AND wr.context->>'warehouse_transfer_id' = v_transfer.id::text
     AND COALESCE(wr.context->>'organization_id', v_transfer.organization_id::text) = v_transfer.organization_id::text
     AND wr.workflow_status IN ('pending', 'in_progress')
   ORDER BY wr.created_at DESC
   LIMIT 1;

  IF v_workflow_run_id IS NULL THEN
    RAISE EXCEPTION
      'ui_execute_warehouse_transfer_checkpoint_v1 transfer % does not have an active warehouse_transfer_execute_v1 workflow',
      v_transfer.id
      USING ERRCODE = '23514';
  END IF;

  SELECT t.*
    INTO v_task
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
   WHERE t.organization_id = v_transfer.organization_id
     AND t.resource_type = 'warehouse_transfer'
     AND t.resource_id = v_transfer.id
     AND COALESCE(t.workflow_run_id, v_workflow_run_id) = v_workflow_run_id
     AND t.status IN ('open', 'assigned', 'pending', 'in_progress')
     AND tt.key = v_task_type_key
   ORDER BY
     CASE t.status WHEN 'pending' THEN 0 ELSE 1 END,
     t.created_at DESC,
     t.id DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'ui_execute_warehouse_transfer_checkpoint_v1 active % task not found for warehouse_transfer %',
      v_task_type_key,
      v_transfer.id
      USING ERRCODE = '23514';
  END IF;

  v_barcode := NULLIF(btrim(COALESCE(v_params->>'barcode', '')), '');
  IF v_barcode IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 requires barcode' USING ERRCODE = '23514';
  END IF;
  v_handling_unit_code := NULLIF(btrim(COALESCE(v_params->>'handling_unit_code', '')), '');
  v_notes := NULLIF(btrim(COALESCE(v_params->>'notes', '')), '');

  BEGIN
    v_branch_id := COALESCE(
      NULLIF(btrim(COALESCE(v_params->>'branch_id', '')), '')::uuid,
      v_branch_id
    );
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 invalid branch_id %', v_params->>'branch_id'
        USING ERRCODE = '22P02';
  END;

  BEGIN
    v_device_id := NULLIF(btrim(COALESCE(v_params->>'device_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 invalid device_id %', v_params->>'device_id'
        USING ERRCODE = '22P02';
  END;

  BEGIN
    v_ops_session_id := NULLIF(btrim(COALESCE(v_params->>'ops_session_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'ui_execute_warehouse_transfer_checkpoint_v1 invalid ops_session_id %', v_params->>'ops_session_id'
        USING ERRCODE = '22P02';
  END;

  v_scan_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), ''),
    concat_ws(
      ':',
      'warehouse_transfer_checkpoint_ui_v1',
      p_action_key,
      v_transfer.id::text,
      v_task.id::text,
      lower(v_barcode),
      COALESCE(lower(v_handling_unit_code), ''),
      COALESCE(v_branch_id::text, ''),
      COALESCE(v_device_id::text, ''),
      COALESCE(v_ops_session_id::text, '')
    )
  );

  SELECT scan_event_id, created
    INTO v_scan_event_id, v_scan_created
    FROM public.record_scan_event_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'idempotency_key', v_scan_idempotency_key,
          'scan_type', 'warehouse_checkpoint',
          'barcode', v_barcode,
          'checkpoint_key', v_checkpoint_key,
          'warehouse_transfer_id', v_transfer.id,
          'handling_unit_code', v_handling_unit_code,
          'device_id', v_device_id,
          'ops_session_id', v_ops_session_id,
          'branch_id', v_branch_id,
          'metadata',
          public.jsonb_deep_merge(
            v_meta,
            jsonb_strip_nulls(
              jsonb_build_object(
                'source', 'ui_execute_warehouse_transfer_checkpoint_v1',
                'action_key', p_action_key,
                'phase', v_phase_key,
                'warehouse_transfer_id', v_transfer.id,
                'task_id', v_task.id,
                'notes', v_notes
              )
            )
          )
        )
      )
    );

  SELECT task_event_id
    INTO v_task_event_id
    FROM public.transition_task_v1(
      v_task.id,
      'completed',
      NULL,
      jsonb_strip_nulls(
        jsonb_build_object(
          'phase', v_phase_key,
          'checkpoint_key', v_checkpoint_key,
          'scan_event_id', v_scan_event_id,
          'scan_created', v_scan_created,
          'barcode', v_barcode,
          'handling_unit_code', v_handling_unit_code,
          'branch_id', v_branch_id,
          'device_id', v_device_id,
          'ops_session_id', v_ops_session_id,
          'notes', v_notes
        )
      ),
      v_scan_idempotency_key
    );

  v_progress := COALESCE(
    public.progress_workflow_run_until_wait_v1(
      v_workflow_run_id,
      jsonb_build_object(
        'source', 'ui_execute_warehouse_transfer_checkpoint_v1',
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'requested_by', v_user_id::text,
        'warehouse_transfer_id', v_transfer.id::text,
        'task_id', v_task.id::text,
        'task_event_id', v_task_event_id::text,
        'scan_event_id', v_scan_event_id::text,
        'checkpoint_key', v_checkpoint_key
      ),
      750,
      8
    ),
    '{}'::jsonb
  );

  SELECT *
    INTO v_transfer_after
    FROM public.warehouse_transfers wt
   WHERE wt.id = v_transfer.id;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'status', 'task_completed',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'phase', v_phase_key,
      'checkpoint_key', v_checkpoint_key,
      'workflow_run_id', v_workflow_run_id,
      'workflow_status', COALESCE(NULLIF(v_progress->>'status', ''), v_existing_workflow_status, 'in_progress'),
      'warehouse_transfer_id', v_transfer.id,
      'transfer_status', v_transfer_after.status,
      'task_id', v_task.id,
      'task_event_id', v_task_event_id,
      'scan_event_id', v_scan_event_id,
      'scan_created', v_scan_created,
      'count', 1,
      'progress', CASE
        WHEN jsonb_typeof(v_progress) = 'object' AND v_progress <> '{}'::jsonb THEN v_progress
        ELSE NULL
      END,
      'items', jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'warehouse_transfer_id', v_transfer.id,
            'workflow_run_id', v_workflow_run_id,
            'transfer_status', v_transfer_after.status,
            'task_id', v_task.id,
            'task_event_id', v_task_event_id,
            'scan_event_id', v_scan_event_id,
            'scan_created', v_scan_created,
            'phase', v_phase_key,
            'checkpoint_key', v_checkpoint_key
          )
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Record warehouse transfer departure/arrival checkpoint scans through the canonical transfer workflow and scan/task SSOT paths.';

REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_execute_warehouse_transfer_checkpoint_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_warehouse_transfer_checkpoint_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) ui_command_registry: warehouse transfer departure/arrival actions
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['warehouse_transfers.scan_departure'],
    jsonb_build_object(
      'key', 'warehouse_transfers.scan_departure',
      'label', 'Scan departure',
      'description', 'Scan the outbound transfer container or manifest barcode to complete branch handoff and advance the canonical transfer workflow.',
      'capability', 'warehouse_transfers.write',
      'schema_category', 'resource:warehouse_transfers',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'workflow',
        'rpc', 'ui_execute_warehouse_transfer_checkpoint_v1',
        'params', '{}'::jsonb,
        'confirm', jsonb_build_object(
          'title', 'Record transfer departure scan?',
          'description', 'This records the transfer load checkpoint, completes the active dispatch task, and advances the canonical transfer workflow.',
          'confirm_label', 'Record departure',
          'cancel_label', 'Cancel',
          'tone', 'default'
        ),
        'input_schema', jsonb_build_object(
          'version', 1,
          'title', 'Departure scan',
          'description', 'Scan the handling unit, container, or manifest barcode that is leaving the branch.',
          'fields', jsonb_build_array(
            jsonb_build_object(
              'key', 'barcode',
              'label', 'Scan barcode',
              'type', 'text',
              'required', true,
              'placeholder', 'BAG-001 / MAN-001'
            ),
            jsonb_build_object(
              'key', 'handling_unit_code',
              'label', 'Handling unit code',
              'type', 'text',
              'required', false,
              'placeholder', 'Optional bag/container code'
            ),
            jsonb_build_object(
              'key', 'device_id',
              'label', 'Device ID',
              'type', 'text',
              'required', false
            ),
            jsonb_build_object(
              'key', 'ops_session_id',
              'label', 'Ops session ID',
              'type', 'text',
              'required', false
            ),
            jsonb_build_object(
              'key', 'notes',
              'label', 'Notes',
              'type', 'textarea',
              'required', false
            )
          )
        )
      )
    ),
    TRUE
  );

  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['warehouse_transfers.scan_arrival'],
    jsonb_build_object(
      'key', 'warehouse_transfers.scan_arrival',
      'label', 'Scan arrival',
      'description', 'Scan the inbound transfer container or manifest barcode to complete destination receipt and advance the canonical transfer workflow.',
      'capability', 'warehouse_transfers.write',
      'schema_category', 'resource:warehouse_transfers',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'workflow',
        'rpc', 'ui_execute_warehouse_transfer_checkpoint_v1',
        'params', '{}'::jsonb,
        'confirm', jsonb_build_object(
          'title', 'Record transfer arrival scan?',
          'description', 'This records the transfer unload checkpoint, completes the active receive task, and advances the canonical transfer workflow.',
          'confirm_label', 'Record arrival',
          'cancel_label', 'Cancel',
          'tone', 'default'
        ),
        'input_schema', jsonb_build_object(
          'version', 1,
          'title', 'Arrival scan',
          'description', 'Scan the handling unit, container, or manifest barcode that arrived at the destination branch.',
          'fields', jsonb_build_array(
            jsonb_build_object(
              'key', 'barcode',
              'label', 'Scan barcode',
              'type', 'text',
              'required', true,
              'placeholder', 'BAG-001 / MAN-001'
            ),
            jsonb_build_object(
              'key', 'handling_unit_code',
              'label', 'Handling unit code',
              'type', 'text',
              'required', false,
              'placeholder', 'Optional bag/container code'
            ),
            jsonb_build_object(
              'key', 'device_id',
              'label', 'Device ID',
              'type', 'text',
              'required', false
            ),
            jsonb_build_object(
              'key', 'ops_session_id',
              'label', 'Ops session ID',
              'type', 'text',
              'required', false
            ),
            jsonb_build_object(
              'key', 'notes',
              'label', 'Notes',
              'type', 'textarea',
              'required', false
            )
          )
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_canonical_commands ? v_command_key THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.scan_departure'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'warehouse_transfers.scan_departure');
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers.scan_arrival'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'warehouse_transfers.scan_arrival');
    END IF;

    v_next := jsonb_set(v_current, ARRAY['commands'], v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose warehouse transfer departure/arrival checkpoint actions through ui_command_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604061520_uc068_warehouse_transfer_checkpoint_ui_contract_v1'));
COMMIT;
