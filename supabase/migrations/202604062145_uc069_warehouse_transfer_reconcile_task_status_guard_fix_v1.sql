-- Plan: PLAN-202604-b05-transfer-execution-surface / Step: S03
-- Migration: UC069 warehouse transfer reconcile task status guard fix v1
-- Date: 2026-04-06
--
-- Goals:
--   - Treat any warehouse_transfer_reconcile task as reusable for the canonical
--     reconcile payload, while still preferring the latest non-terminal row.
--   - Preserve replay safety without rejecting assigned/open reconcile tasks
--     before the operator completes them.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604062145_uc069_warehouse_transfer_reconcile_task_status_guard_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
     CASE
       WHEN lower(COALESCE(t.status, '')) IN ('completed', 'canceled', 'exception') THEN 1
       ELSE 0
     END,
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
     AND wr.workflow_status IN ('pending', 'in_progress', 'waiting')
   ORDER BY wr.created_at DESC
   LIMIT 1;

  IF v_workflow_run_id IS NOT NULL THEN
    v_progress := COALESCE(
      public.progress_workflow_run(
        v_workflow_run_id,
        jsonb_build_object(
          'source', 'ui_execute_warehouse_transfer_reconcile_v1',
          'action_key', p_action_key,
          'resource_key', p_resource_key,
          'requested_by', v_user_id::text,
          'warehouse_transfer_id', v_transfer.id::text,
          'task_id', v_task.id::text,
          'task_event_id', v_existing_task_event_id::text
        )
      ),
      '{}'::jsonb
    );
  END IF;

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
      'workflow_status', COALESCE(NULLIF(v_progress->>'status', ''), v_existing_workflow_status),
      'task_id', v_task.id,
      'task_event_id', v_existing_task_event_id,
      'idempotency_key', v_effective_idempotency_key,
      'replayed', v_replayed,
      'count', 1,
      'progress', CASE
        WHEN jsonb_typeof(v_progress) = 'object' AND v_progress <> '{}'::jsonb THEN v_progress
        ELSE NULL
      END,
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
  IS 'Complete the active warehouse_transfer_reconcile task for a visible received transfer and wake the canonical workflow through progress_workflow_run.';

REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604062145_uc069_warehouse_transfer_reconcile_task_status_guard_fix_v1'));
COMMIT;
