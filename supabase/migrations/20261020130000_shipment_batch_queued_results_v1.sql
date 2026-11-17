-- Distinguish accepted workflow work from completed shipment batch mutations.
-- Keep authentication, visibility, capability and idempotency checks unchanged.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('20261020130000_shipment_batch_queued_results_v1'));
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_execute_shipment_batch_operation_v1(
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
SET search_path TO public, workflow_handlers, extensions, pg_temp
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
  v_ids TEXT[] := ARRAY[]::TEXT[];
  v_id TEXT := NULLIF(btrim(COALESCE(p_selection_id, '')), '');
  v_selected_id_text TEXT := NULL;
  v_selected_uuid UUID := NULL;
  v_visible_shipment JSONB := NULL;
  v_operation TEXT := NULL;
  v_surface TEXT := 'ui';
  v_reason TEXT := NULL;
  v_slot_date DATE := NULL;
  v_idempotency_key TEXT := NULL;
  v_result JSONB := '{}'::jsonb;
  v_item JSONB := '{}'::jsonb;
  v_items JSONB := '[]'::jsonb;
  v_item_status TEXT := NULL;
  v_item_error JSONB := NULL;
  v_item_ok BOOLEAN := FALSE;
  v_item_already_processed BOOLEAN := FALSE;
  v_success_count INT := 0;
  v_failure_count INT := 0;
  v_queued_count INT := 0;
  v_already_processed_count INT := 0;
  v_first_workflow_run_id TEXT := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_batch_operation_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_shipment_batch_operation_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_shipment_batch_operation_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_batch_operation_v1 unknown command %', p_action_key;
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

  SELECT COALESCE(array_agg(src.value ORDER BY src.ord), ARRAY[]::TEXT[])
    INTO v_ids
    FROM (
      SELECT DISTINCT ON (cleaned) cleaned AS value, ord
      FROM (
        SELECT NULLIF(btrim(value), '') AS cleaned, ord
        FROM unnest(COALESCE(p_selection_ids, ARRAY[]::TEXT[])) WITH ORDINALITY AS input(value, ord)
      ) deduped
      WHERE cleaned IS NOT NULL
      ORDER BY cleaned, ord
    ) src;

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
    RAISE EXCEPTION 'ui_execute_shipment_batch_operation_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_shipment_batch_operation_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);
  v_operation := lower(NULLIF(btrim(COALESCE(v_params->>'operation', '')), ''));
  v_surface := lower(COALESCE(NULLIF(btrim(COALESCE(v_params->>'surface', '')), ''), 'ui'));
  v_reason := NULLIF(btrim(COALESCE(v_params->>'reason', '')), '');
  v_idempotency_key := NULLIF(btrim(COALESCE(v_params->>'idempotency_key', '')), '');

  BEGIN
    v_slot_date := NULLIF(v_params->>'slot_date', '')::DATE;
  EXCEPTION
    WHEN others THEN
      v_slot_date := NULL;
  END;

  IF v_operation NOT IN ('cancel', 'reschedule') THEN
    RAISE EXCEPTION 'ui_execute_shipment_batch_operation_v1 unsupported operation %', COALESCE(v_operation, '<null>');
  END IF;

  IF v_operation = 'reschedule' AND v_slot_date IS NULL THEN
    RAISE EXCEPTION 'ui_execute_shipment_batch_operation_v1 slot_date is required for reschedule'
      USING ERRCODE = '23514';
  END IF;

  FOR v_selected_id_text IN
    SELECT value FROM unnest(v_ids) AS selection(value)
  LOOP
    v_selected_uuid := NULL;
    v_visible_shipment := NULL;
    v_result := '{}'::jsonb;
    v_item_status := NULL;
    v_item_error := NULL;
    v_item_ok := FALSE;
    v_item_already_processed := FALSE;

    BEGIN
      BEGIN
        v_selected_uuid := NULLIF(btrim(COALESCE(v_selected_id_text, '')), '')::UUID;
      EXCEPTION
        WHEN others THEN
          v_selected_uuid := NULL;
      END;

      IF v_selected_uuid IS NULL THEN
        v_item_error := jsonb_build_object(
          'code', 'invalid_shipment_id',
          'selection_id', v_selected_id_text
        );
        v_item_status := 'blocked';
        v_failure_count := v_failure_count + 1;
      ELSE
        v_visible_shipment := public.ui_get_resource_v1(p_resource_key, v_selected_uuid);
        IF v_visible_shipment IS NULL THEN
          v_item_error := jsonb_build_object(
            'code', 'shipment_not_visible',
            'shipment_id', v_selected_uuid
          );
          v_item_status := 'blocked';
          v_failure_count := v_failure_count + 1;
        ELSE
          v_result := public.shipment_amend_cancel_v1(
            jsonb_strip_nulls(
              jsonb_build_object(
                'shipment_id', v_selected_uuid,
                'operation', v_operation,
                'surface', v_surface,
                'reason', CASE WHEN v_operation = 'cancel' THEN v_reason ELSE NULL END,
                'slot_date', CASE WHEN v_operation = 'reschedule' THEN v_slot_date ELSE NULL END,
                'idempotency_key', CASE
                  WHEN v_idempotency_key IS NULL THEN NULL
                  ELSE format('%s:%s', v_idempotency_key, v_selected_uuid)
                END
              )
            )
          );

          v_item_ok := COALESCE((v_result->>'ok')::BOOLEAN, FALSE);
          v_item_already_processed := COALESCE((v_result->>'already_processed')::BOOLEAN, FALSE);

          IF v_first_workflow_run_id IS NULL THEN
            v_first_workflow_run_id := NULLIF(v_result->>'workflow_run_id', '');
          END IF;

          IF v_item_already_processed THEN
            v_already_processed_count := v_already_processed_count + 1;
            v_item_status := 'already_processed';
          ELSIF v_item_ok AND v_result->>'workflow_status' = 'completed'
             AND NULLIF(v_result->>'workflow_run_id', '') IS NOT NULL
             AND (
               (v_operation = 'cancel' AND v_result#>>'{operation_result,status}' = 'cancelled')
               OR (v_operation = 'reschedule'
                 AND v_result#>>'{operation_result,operation}' IN ('rescheduled', 'reschedule_no_change')
                 AND v_result#>>'{operation_result,slot_date}' = v_slot_date::TEXT)
             ) THEN
            v_success_count := v_success_count + 1;
            v_item_status := CASE WHEN v_operation = 'cancel' THEN 'cancelled' ELSE 'rescheduled' END;
          ELSIF v_item_ok AND NULLIF(v_result->>'workflow_run_id', '') IS NOT NULL
             AND v_result->>'workflow_status' IN ('pending', 'in_progress', 'running', 'waiting') THEN
            -- The standalone RPC accepts queued work; acceptance is not completion.
            v_queued_count := v_queued_count + 1;
            v_item_status := 'queued';
          ELSE
            v_item_ok := FALSE;
            v_failure_count := v_failure_count + 1;
            v_item_error := COALESCE(
              v_result->'error',
              jsonb_build_object('code', 'shipment_batch_operation_failed')
            );
            v_item_status := COALESCE(
              NULLIF(v_result#>>'{error,code}', ''),
              NULLIF(v_result#>>'{operation_result,status}', ''),
              NULLIF(v_result->>'workflow_status', ''),
              'blocked'
            );
          END IF;
        END IF;
      END IF;
    EXCEPTION
      WHEN others THEN
        v_item_ok := FALSE;
        v_item_error := jsonb_build_object(
          'code', 'shipment_batch_operation_failed',
          'message', SQLERRM
        );
        v_item_status := 'failed';
        v_failure_count := v_failure_count + 1;
    END;

    v_item := jsonb_strip_nulls(
      jsonb_build_object(
        'shipment_id', v_selected_uuid,
        'selection_id', v_selected_id_text,
        'status', v_item_status,
        'ok', CASE WHEN v_item_ok THEN TRUE ELSE NULL END,
        'already_processed', CASE WHEN v_item_already_processed THEN TRUE ELSE NULL END,
        'workflow_run_id', NULLIF(v_result->>'workflow_run_id', ''),
        'shipment_action_id', NULLIF(v_result->>'shipment_action_id', ''),
        'workflow_status', NULLIF(v_result->>'workflow_status', ''),
        'workflow_step_status', NULLIF(v_result->>'workflow_step_status', ''),
        'lock_state', v_result->'lock_state',
        'operation_result', v_result->'operation_result',
        'error', v_item_error
      )
    );

    v_items := v_items || jsonb_build_array(v_item);
  END LOOP;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'status',
      CASE
        WHEN v_failure_count > 0 AND (v_success_count + v_already_processed_count + v_queued_count) > 0 THEN 'partial'
        WHEN v_failure_count > 0 THEN 'failed'
        WHEN v_queued_count > 0 THEN 'queued'
        WHEN v_success_count = 0 AND v_already_processed_count > 0 THEN 'already_processed'
        WHEN v_operation = 'cancel' THEN 'cancelled'
        WHEN v_operation = 'reschedule' THEN 'rescheduled'
        ELSE 'completed'
      END,
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'operation', v_operation,
      'count', v_count,
      'success_count', v_success_count,
      'failure_count', v_failure_count,
      'queued_count', v_queued_count,
      'already_processed_count', v_already_processed_count,
      'workflow_run_id', v_first_workflow_run_id,
      'items', v_items
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_shipment_batch_operation_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Execute visible shipment cancel/reschedule cohort actions with disjoint completed, queued, failed and already-processed outcomes; queued acceptance is not mutation completion.';

REVOKE ALL ON FUNCTION public.ui_execute_shipment_batch_operation_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_shipment_batch_operation_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_shipment_batch_operation_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

COMMIT;
