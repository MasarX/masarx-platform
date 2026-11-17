-- Migration: isolate workflow worker steps into independent transactions
-- Purpose:
--  - Release locks from each progressed step before any later handler in the same run executes.
--  - Preserve row-driven per-run step budgets and batch throughput in the top-level cron procedure.
--  - Keep compatibility entrypoints fail-closed and free of transaction control.

BEGIN;
SELECT pg_advisory_lock(hashtext('202608151020_workflow_worker_step_transaction_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.run_workflow_engine_worker_step_v1(
  p_workflow_run_id uuid DEFAULT NULL,
  p_excluded_run_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_run_id uuid;
  v_progress jsonb;
BEGIN
  SELECT wr.id
  INTO v_run_id
  FROM public.workflow_runs wr
  WHERE wr.workflow_status IN ('pending', 'in_progress', 'waiting')
    AND (p_workflow_run_id IS NULL OR wr.id = p_workflow_run_id)
    AND NOT (wr.id = ANY(COALESCE(p_excluded_run_ids, ARRAY[]::uuid[])))
    AND EXISTS (
      SELECT 1
      FROM public.workflow_run_steps wrs
      WHERE wrs.workflow_run_id = wr.id
        AND wrs.step_status = 'pending'
        AND wrs.run_at <= now()
    )
  ORDER BY
    CASE wr.workflow_status
      WHEN 'in_progress' THEN 0
      WHEN 'waiting' THEN 1
      WHEN 'pending' THEN 2
      ELSE 3
    END,
    wr.updated_at ASC,
    wr.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_run_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'idle',
      'items_processed', 0,
      'error_occurred', false
    );
  END IF;

  BEGIN
    v_progress := public.progress_workflow_run(v_run_id);
  EXCEPTION
    WHEN OTHERS THEN
      RETURN jsonb_build_object(
        'status', 'error',
        'workflow_run_id', v_run_id,
        'items_processed', 0,
        'error_occurred', true,
        'error', SQLERRM
      );
  END;

  RETURN jsonb_build_object(
    'status', 'completed',
    'workflow_run_id', v_run_id,
    'items_processed', CASE WHEN v_progress ? 'step_id' THEN 1 ELSE 0 END,
    'error_occurred', false,
    'progress', COALESCE(v_progress, '{}'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.run_workflow_engine_worker_step_v1(uuid, uuid[])
  IS 'Select or continue one due workflow run and progress exactly one step in the caller transaction.';

REVOKE ALL ON FUNCTION public.run_workflow_engine_worker_step_v1(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.run_workflow_engine_worker_once_v1(
  p_max_steps int DEFAULT 5,
  p_excluded_run_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_max_steps int := LEAST(GREATEST(COALESCE(p_max_steps, 5), 1), 25);
  v_result jsonb;
BEGIN
  v_result := public.run_workflow_engine_worker_step_v1(NULL, p_excluded_run_ids);
  RETURN COALESCE(v_result, '{}'::jsonb)
    || jsonb_build_object('max_steps_per_tick', v_max_steps);
END;
$$;

COMMENT ON FUNCTION public.run_workflow_engine_worker_once_v1(int, uuid[])
  IS 'Compatibility helper that progresses at most one workflow step; the top-level procedure owns multi-step transaction boundaries.';

REVOKE ALL ON FUNCTION public.run_workflow_engine_worker_once_v1(int, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE PROCEDURE public.run_workflow_engine_worker_batch_v1()
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_throttle record;
  v_context uuid;
  v_result jsonb;
  v_progress jsonb;
  v_processed_steps int := 0;
  v_error boolean := false;
  v_stop_batch boolean := false;
  v_max_steps int;
  v_batch_index int;
  v_step_index int;
  v_processed_run_ids uuid[] := ARRAY[]::uuid[];
  v_current_run_id uuid;
  v_status text;
  v_next_run_at timestamptz;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_engine_worker');
  IF NOT v_throttle.should_run THEN
    RETURN;
  END IF;

  v_max_steps := public.resolve_workflow_engine_worker_max_steps_v1();
  v_context := public.create_request_context('workflow_engine_worker');

  <<run_batch>>
  FOR v_batch_index IN 1..GREATEST(COALESCE(v_throttle.batch_size, 1), 1) LOOP
    v_current_run_id := NULL;

    FOR v_step_index IN 1..v_max_steps LOOP
      v_result := public.run_workflow_engine_worker_step_v1(
        v_current_run_id,
        v_processed_run_ids
      );

      IF COALESCE(v_result->>'status', '') = 'idle' THEN
        IF v_current_run_id IS NULL THEN
          EXIT run_batch;
        END IF;
        EXIT;
      END IF;

      v_current_run_id := NULLIF(v_result->>'workflow_run_id', '')::uuid;
      v_progress := COALESCE(v_result->'progress', '{}'::jsonb);
      v_status := lower(COALESCE(v_progress->>'status', ''));
      v_next_run_at := NULL;
      BEGIN
        v_next_run_at := NULLIF(v_progress->>'next_run_at', '')::timestamptz;
      EXCEPTION
        WHEN OTHERS THEN
          v_next_run_at := NULL;
      END;

      v_processed_steps := v_processed_steps
        + COALESCE(NULLIF(v_result->>'items_processed', '')::int, 0);
      v_error := v_error OR COALESCE((v_result->>'error_occurred')::boolean, false);
      v_stop_batch := COALESCE((v_result->>'error_occurred')::boolean, false);

      COMMIT;
      PERFORM set_config('request.correlation_id', v_context::text, true);

      EXIT WHEN v_stop_batch;
      EXIT WHEN v_status IN ('waiting', 'failed', 'cancelled', 'blocked');
      EXIT WHEN v_next_run_at IS NOT NULL;
      EXIT WHEN (v_progress ? 'step_id') IS FALSE;
    END LOOP;

    IF v_current_run_id IS NOT NULL THEN
      v_processed_run_ids := array_append(v_processed_run_ids, v_current_run_id);
    END IF;

    EXIT WHEN v_stop_batch;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_processed_steps);
  PERFORM public.update_cron_config('workflow_engine_worker');
END;
$$;

COMMENT ON PROCEDURE public.run_workflow_engine_worker_batch_v1()
  IS 'Progress a row-driven workflow batch and commit after every step so locks never span later handlers or unrelated runs.';

REVOKE ALL ON PROCEDURE public.run_workflow_engine_worker_batch_v1()
  FROM PUBLIC, anon, authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202608151020_workflow_worker_step_transaction_v1'));
COMMIT;
