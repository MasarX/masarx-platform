-- Console V2 Workflows: preserve bulk task action payloads through the
-- canonical transition_task_v1 path so bulk Snooze keeps snooze_until in
-- task_event readback instead of status-only evidence.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605242030_bulk_transition_tasks_payload_readback_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.bulk_transition_tasks_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID;
  v_to_status TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'to_status', '')), ''));
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_payload JSONB := CASE
    WHEN jsonb_typeof(p_args->'payload') = 'object' THEN p_args->'payload'
    ELSE '{}'::jsonb
  END;
  v_task_ids UUID[];
  v_task_id UUID;
  v_task_result RECORD;
  v_task_event_payload JSONB := '{}'::jsonb;
  v_succeeded INTEGER := 0;
  v_failed INTEGER := 0;
  v_total INTEGER := 0;
  v_failures JSONB := '[]'::jsonb;
  v_outcomes JSONB := '[]'::jsonb;
  v_err_text TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'bulk_transition_tasks_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('tasks.write');

  IF v_to_status IS NULL THEN
    RAISE EXCEPTION 'bulk_transition_tasks_v1 requires to_status'
      USING ERRCODE = '23502';
  END IF;
  IF jsonb_typeof(p_args->'task_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'bulk_transition_tasks_v1 requires task_ids array'
      USING ERRCODE = '23502';
  END IF;

  SELECT array_agg(elem::uuid)
    INTO v_task_ids
    FROM jsonb_array_elements_text(p_args->'task_ids') AS elem;

  IF v_task_ids IS NULL OR array_length(v_task_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'bulk_transition_tasks_v1 task_ids array is empty'
      USING ERRCODE = '23502';
  END IF;

  v_total := array_length(v_task_ids, 1);

  FOREACH v_task_id IN ARRAY v_task_ids LOOP
    BEGIN
      SELECT * INTO v_task_result
        FROM public.transition_task_v1(
          v_task_id,
          v_to_status,
          v_reason,
          jsonb_strip_nulls(v_payload || jsonb_build_object('bulk_correlation_id', v_correlation_id)),
          v_correlation_id::text || '-' || v_task_id::text
        );
      SELECT COALESCE(te.payload, '{}'::jsonb)
        INTO v_task_event_payload
        FROM public.task_events te
       WHERE te.id = v_task_result.task_event_id
       LIMIT 1;
      v_succeeded := v_succeeded + 1;
      v_outcomes := v_outcomes || jsonb_build_array(jsonb_build_object(
        'task_id', v_task_id,
        'ok', true,
        'task_event_id', v_task_result.task_event_id,
        'task_event_payload', v_task_event_payload
      ));
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_err_text := SQLERRM;
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'task_id', v_task_id,
        'sqlstate', SQLSTATE,
        'message', v_err_text
      ));
      v_outcomes := v_outcomes || jsonb_build_array(jsonb_build_object(
        'task_id', v_task_id,
        'ok', false,
        'sqlstate', SQLSTATE,
        'message', v_err_text
      ));
    END;
  END LOOP;

  INSERT INTO public.task_bulk_transition_runs (
    organization_id, to_status, reason,
    total_count, succeeded_count, failed_count, failures,
    triggered_by, correlation_id, decision_log_id
  ) VALUES (
    v_org_id, v_to_status, v_reason,
    v_total, v_succeeded, v_failed, v_failures,
    v_user_id, v_correlation_id, v_decision_id
  )
  RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'tasks.bulk_transition', 'task_bulk_run', v_resource_id,
    'bulk_transition_tasks_v1',
    CASE WHEN v_failed = 0 THEN 'all_succeeded' WHEN v_succeeded = 0 THEN 'all_failed' ELSE 'partial' END,
    jsonb_build_object('to_status', v_to_status, 'total', v_total, 'succeeded', v_succeeded, 'failed', v_failed),
    'bulk_transition_tasks_v1', v_correlation_id
  );

  IF v_org_id IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_org_id, 'tasks.bulk_transition', 'task_bulk_run', v_resource_id,
      jsonb_build_object('to_status', v_to_status, 'total', v_total, 'succeeded', v_succeeded, 'failed', v_failed),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', v_failed = 0,
    'task_bulk_run_id', v_resource_id,
    'to_status', v_to_status,
    'total', v_total,
    'succeeded', v_succeeded,
    'failed', v_failed,
    'outcomes', v_outcomes,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_transition_tasks_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_transition_tasks_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_transition_tasks_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.bulk_transition_tasks_v1(jsonb)
  IS 'Canonical write RPC: iterate transition_task_v1 over an array; aggregate per-task results into task_bulk_transition_runs ledger. Capability: tasks.write. Preserves caller payload in task_event readback.';

SELECT pg_advisory_unlock(hashtext('202605242030_bulk_transition_tasks_payload_readback_v1'));
COMMIT;
