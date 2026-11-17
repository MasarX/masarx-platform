-- Plan: PLAN-202604-b05-transfer-execution-surface / Step: S02
-- Migration: UC069 warehouse transfer reconcile UI contract v1
-- Date: 2026-04-06
--
-- Goals:
--   - Expose a browser-safe Portal/Console action to complete the active
--     warehouse_transfer_reconcile task against a visible warehouse_transfer.
--   - Keep transfer discrepancy handling workflow-engine first by completing
--     the task through transition_task_v1 and letting the canonical workflow
--     engine observe the completed task through its normal progression path.
--   - Preserve replay safety with deterministic task-level idempotency while
--     avoiding a second ad-hoc reconcile payload schema.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604062131_uc069_warehouse_transfer_reconcile_ui_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Dedicated UI executor for warehouse transfer reconciliation
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(
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
  v_task public.tasks%ROWTYPE;
  v_existing_task_event_id UUID := NULL;
  v_transition RECORD;
  v_workflow_run_id UUID := NULL;
  v_existing_workflow_status TEXT := NULL;
  v_progress JSONB := '{}'::jsonb;
  v_result_transfer public.warehouse_transfers%ROWTYPE;
  v_requested_idempotency_key TEXT := NULL;
  v_effective_idempotency_key TEXT := NULL;
  v_replayed BOOLEAN := FALSE;
  v_received_count INTEGER := NULL;
  v_damaged_count INTEGER := NULL;
  v_missing_count INTEGER := NULL;
  v_unmanifested_count INTEGER := NULL;
  v_reconcile_notes TEXT := NULL;
  v_payload JSONB := '{}'::jsonb;
  v_damaged_shipments JSONB := NULL;
  v_missing_shipments JSONB := NULL;
  v_unmanifested_shipments JSONB := NULL;
BEGIN
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 unknown command %', p_action_key;
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
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);

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
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 invalid warehouse_transfer id %', v_selection_id_text;
  END IF;

  v_visible_transfer := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
  IF v_visible_transfer IS NULL THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 warehouse_transfer % is not visible in resource %', v_selection_uuid, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_transfer
    FROM public.warehouse_transfers wt
   WHERE wt.id = v_selection_uuid
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 warehouse_transfer % not found', v_selection_uuid
      USING ERRCODE = '23503';
  END IF;

  IF lower(COALESCE(v_transfer.status, '')) <> 'received' THEN
    RAISE EXCEPTION
      'ui_execute_warehouse_transfer_reconcile_v1 only supports received warehouse_transfers (current status %)',
      v_transfer.status
      USING ERRCODE = '23514';
  END IF;

  SELECT t.*
    INTO v_task
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
   WHERE t.resource_type = 'warehouse_transfer'
     AND t.resource_id = v_transfer.id
     AND t.organization_id = v_transfer.organization_id
     AND tt.key = 'warehouse_transfer_reconcile'
   ORDER BY
     CASE WHEN lower(COALESCE(t.status, '')) IN ('pending', 'in_progress') THEN 0 ELSE 1 END,
     t.created_at DESC
   LIMIT 1
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_execute_warehouse_transfer_reconcile_v1 no warehouse_transfer_reconcile task found for %', v_transfer.id
      USING ERRCODE = '23503';
  END IF;

  v_requested_idempotency_key := NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), '');
  v_effective_idempotency_key := COALESCE(
    v_requested_idempotency_key,
    format(
      'ui-warehouse-transfer-reconcile:%s:%s:%s:%s',
      lower(p_action_key),
      lower(p_resource_key),
      v_task.id,
      v_user_id
    )
  );

  SELECT te.id
    INTO v_existing_task_event_id
    FROM public.task_events te
   WHERE te.task_id = v_task.id
     AND te.idempotency_key = v_effective_idempotency_key
   ORDER BY te.created_at DESC
   LIMIT 1;

  IF v_existing_task_event_id IS NOT NULL THEN
    v_replayed := TRUE;
  ELSE
    IF lower(COALESCE(v_task.status, '')) NOT IN ('pending', 'in_progress') THEN
      RAISE EXCEPTION
        'ui_execute_warehouse_transfer_reconcile_v1 no active reconcile task is available for warehouse_transfer %',
        v_transfer.id
        USING ERRCODE = '23514';
    END IF;

    BEGIN
      v_received_count := NULLIF(btrim(COALESCE(v_params->>'received_shipment_count', '')), '')::INT;
    EXCEPTION
      WHEN others THEN
        v_received_count := NULL;
    END;
    BEGIN
      v_damaged_count := NULLIF(btrim(COALESCE(v_params->>'damaged_shipment_count', '')), '')::INT;
    EXCEPTION
      WHEN others THEN
        v_damaged_count := NULL;
    END;
    BEGIN
      v_missing_count := NULLIF(btrim(COALESCE(v_params->>'missing_shipment_count', '')), '')::INT;
    EXCEPTION
      WHEN others THEN
        v_missing_count := NULL;
    END;
    BEGIN
      v_unmanifested_count := NULLIF(btrim(COALESCE(v_params->>'unmanifested_shipment_count', '')), '')::INT;
    EXCEPTION
      WHEN others THEN
        v_unmanifested_count := NULL;
    END;

    IF v_received_count IS NULL THEN
      RAISE EXCEPTION
        'ui_execute_warehouse_transfer_reconcile_v1 requires received_shipment_count'
        USING ERRCODE = '23514';
    END IF;

    IF COALESCE(v_received_count, 0) < 0
       OR COALESCE(v_damaged_count, 0) < 0
       OR COALESCE(v_missing_count, 0) < 0
       OR COALESCE(v_unmanifested_count, 0) < 0 THEN
      RAISE EXCEPTION
        'ui_execute_warehouse_transfer_reconcile_v1 counts must be >= 0'
        USING ERRCODE = '23514';
    END IF;

    v_reconcile_notes := NULLIF(
      btrim(COALESCE(v_params->>'reconcile_notes', v_params->>'notes', '')),
      ''
    );

    IF jsonb_typeof(v_params->'damaged_shipments') = 'array' THEN
      v_damaged_shipments := v_params->'damaged_shipments';
    END IF;
    IF jsonb_typeof(v_params->'missing_shipments') = 'array' THEN
      v_missing_shipments := v_params->'missing_shipments';
    END IF;
    IF jsonb_typeof(v_params->'unmanifested_shipments') = 'array' THEN
      v_unmanifested_shipments := v_params->'unmanifested_shipments';
    END IF;

    v_payload := jsonb_strip_nulls(
      jsonb_build_object(
        'received_shipment_count', v_received_count,
        'damaged_shipment_count', v_damaged_count,
        'missing_shipment_count', v_missing_count,
        'unmanifested_shipment_count', v_unmanifested_count,
        'reconcile_notes', v_reconcile_notes,
        'damaged_shipments', v_damaged_shipments,
        'missing_shipments', v_missing_shipments,
        'unmanifested_shipments', v_unmanifested_shipments
      )
    );

    SELECT *
      INTO v_transition
      FROM public.transition_task_v1(
        p_task_id := v_task.id,
        p_to_status := 'completed',
        p_status_reason := NULL,
        p_payload := v_payload,
        p_idempotency_key := v_effective_idempotency_key
      )
      LIMIT 1;

    v_existing_task_event_id := v_transition.task_event_id;
  END IF;

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

  SELECT *
    INTO v_result_transfer
    FROM public.warehouse_transfers wt
   WHERE wt.id = v_transfer.id;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'status', CASE WHEN v_replayed THEN 'reconcile_recorded_replay' ELSE 'reconcile_recorded' END,
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'warehouse_transfer_id', v_result_transfer.id,
      'transfer_status', v_result_transfer.status,
      'workflow_run_id', v_workflow_run_id,
      'workflow_status', v_existing_workflow_status,
      'task_id', v_task.id,
      'task_event_id', v_existing_task_event_id,
      'idempotency_key', v_effective_idempotency_key,
      'replayed', v_replayed,
      'count', 1,
      'items', jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'warehouse_transfer_id', v_result_transfer.id,
            'transfer_status', v_result_transfer.status,
            'workflow_run_id', v_workflow_run_id,
            'task_id', v_task.id,
            'task_event_id', v_existing_task_event_id,
            'replayed', v_replayed
          )
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Complete the active warehouse_transfer_reconcile task for a visible received transfer using the canonical reconcile payload.';

REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_warehouse_transfer_reconcile_v1(
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
  SELECT public.ui_execute_warehouse_transfer_reconcile_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) ui_command_registry: warehouse transfer reconcile command
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
  v_reconcile_seen BOOLEAN := FALSE;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['warehouse_transfers.reconcile_destination'],
    jsonb_build_object(
      'key', 'warehouse_transfers.reconcile_destination',
      'label', 'Reconcile transfer',
      'description', 'Record the destination reconciliation counts for the selected received transfer using the canonical reconcile payload.',
      'capability', 'warehouse_transfers.write',
      'schema_category', 'resource:warehouse_transfers',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'workflow',
        'rpc', 'ui_execute_warehouse_transfer_reconcile_v1',
        'params', '{}'::jsonb,
        'input_schema', jsonb_build_object(
          'version', 1,
          'title', 'Destination reconciliation',
          'fields', jsonb_build_array(
            jsonb_build_object(
              'key', 'received_shipment_count',
              'label', 'Received shipment count',
              'type', 'text',
              'required', TRUE
            ),
            jsonb_build_object(
              'key', 'damaged_shipment_count',
              'label', 'Damaged shipment count',
              'type', 'text',
              'required', FALSE
            ),
            jsonb_build_object(
              'key', 'missing_shipment_count',
              'label', 'Missing shipment count',
              'type', 'text',
              'required', FALSE
            ),
            jsonb_build_object(
              'key', 'unmanifested_shipment_count',
              'label', 'Unmanifested shipment count',
              'type', 'text',
              'required', FALSE
            ),
            jsonb_build_object(
              'key', 'reconcile_notes',
              'label', 'Reconcile notes',
              'type', 'textarea',
              'required', FALSE
            )
          )
        ),
        'confirm', jsonb_build_object(
          'title', 'Record transfer reconciliation?',
          'description', 'This completes the active reconcile task for the selected received transfer and advances the canonical discrepancy workflow.',
          'confirm_label', 'Record reconciliation',
          'cancel_label', 'Cancel',
          'tone', 'default'
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
      IF v_command_key IN ('warehouse_transfers.reconcile', 'warehouse_transfers.reconcile_destination') THEN
        IF NOT v_reconcile_seen THEN
          v_reconcile_seen := TRUE;
          v_command := public.deep_merge_jsonb(v_canonical_commands->'warehouse_transfers.reconcile_destination', v_command);
          v_command := jsonb_set(
            v_command,
            ARRAY['key'],
            to_jsonb('warehouse_transfers.reconcile_destination'::text),
            TRUE
          );
          v_command := jsonb_set(
            v_command,
            ARRAY['execution', 'type'],
            to_jsonb('workflow'::text),
            TRUE
          );
          v_next_commands := v_next_commands || jsonb_build_array(v_command);
        END IF;
        CONTINUE;
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT v_reconcile_seen THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'warehouse_transfers.reconcile_destination');
    END IF;

    v_next := jsonb_set(v_current, ARRAY['commands'], v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose warehouse_transfers.reconcile_destination through ui_command_registry.',
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

SELECT pg_advisory_unlock(hashtext('202604062131_uc069_warehouse_transfer_reconcile_ui_contract_v1'));
COMMIT;
