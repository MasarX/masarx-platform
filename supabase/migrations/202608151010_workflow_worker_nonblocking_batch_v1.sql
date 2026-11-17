-- Migration: isolate workflow worker runs into independent transactions
-- Purpose:
--  - Keep each workflow run in its own top-level transaction so polling handlers cannot retain locks across a batch.
--  - Preserve row-driven batch throughput through a pg_cron CALL procedure that commits after every run.
--  - Keep run_workflow_engine_worker() as a safe one-run compatibility wrapper.

BEGIN;
SELECT pg_advisory_lock(hashtext('202608151010_workflow_worker_nonblocking_batch_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_workflow_engine_worker_max_steps_v1()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_defaults jsonb;
  v_max_steps int := 5;
BEGIN
  v_defaults := public.resolve_settings('workflow_defaults', 'global', NULL);
  BEGIN
    v_max_steps := COALESCE(NULLIF(v_defaults->>'max_steps_per_tick', '')::int, v_max_steps);
  EXCEPTION
    WHEN others THEN
      v_max_steps := 5;
  END;

  RETURN LEAST(GREATEST(v_max_steps, 1), 25);
END;
$$;

COMMENT ON FUNCTION public.resolve_workflow_engine_worker_max_steps_v1()
  IS 'Resolve the row-driven per-run workflow step budget for worker invocations.';

REVOKE ALL ON FUNCTION public.resolve_workflow_engine_worker_max_steps_v1() FROM PUBLIC, anon, authenticated, service_role;

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
  v_pending_run_id uuid;
  v_progress jsonb;
  v_processed_steps int := 0;
  v_i int := 0;
  v_status text;
  v_next_run_at timestamptz;
  v_max_steps int := LEAST(GREATEST(COALESCE(p_max_steps, 5), 1), 25);
BEGIN
  SELECT wr.id
  INTO v_pending_run_id
  FROM public.workflow_runs wr
  WHERE wr.workflow_status IN ('pending', 'in_progress', 'waiting')
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

  IF v_pending_run_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'idle',
      'items_processed', 0,
      'error_occurred', false,
      'max_steps_per_tick', v_max_steps
    );
  END IF;

  BEGIN
    LOOP
      v_i := v_i + 1;
      EXIT WHEN v_i > v_max_steps;

      v_progress := public.progress_workflow_run(v_pending_run_id);
      v_status := NULLIF(v_progress->>'status', '');
      v_next_run_at := NULL;

      BEGIN
        v_next_run_at := (v_progress->>'next_run_at')::timestamptz;
      EXCEPTION
        WHEN others THEN
          v_next_run_at := NULL;
      END;

      IF v_progress ? 'step_id' THEN
        v_processed_steps := v_processed_steps + 1;
      END IF;

      IF v_status IN ('waiting', 'failed', 'cancelled') THEN
        EXIT;
      END IF;
      IF v_next_run_at IS NOT NULL THEN
        EXIT;
      END IF;
      IF (v_progress ? 'step_id') IS FALSE THEN
        EXIT;
      END IF;
    END LOOP;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN jsonb_build_object(
        'status', 'error',
        'workflow_run_id', v_pending_run_id,
        'items_processed', v_processed_steps,
        'error_occurred', true,
        'error', SQLERRM,
        'max_steps_per_tick', v_max_steps
      );
  END;

  RETURN jsonb_build_object(
    'status', 'completed',
    'workflow_run_id', v_pending_run_id,
    'items_processed', v_processed_steps,
    'error_occurred', false,
    'max_steps_per_tick', v_max_steps,
    'progress', COALESCE(v_progress, '{}'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.run_workflow_engine_worker_once_v1(int, uuid[])
  IS 'Progress at most one due workflow run; the caller owns the transaction boundary.';

REVOKE ALL ON FUNCTION public.run_workflow_engine_worker_once_v1(int, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.run_workflow_engine_worker()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
DECLARE
  v_throttle record;
  v_context uuid;
  v_result jsonb;
  v_processed_steps int := 0;
  v_error boolean := false;
  v_max_steps int;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_engine_worker');
  IF NOT v_throttle.should_run THEN
    RETURN jsonb_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_max_steps := public.resolve_workflow_engine_worker_max_steps_v1();
  v_context := public.create_request_context('workflow_engine_worker');
  v_result := public.run_workflow_engine_worker_once_v1(v_max_steps);
  v_processed_steps := COALESCE(NULLIF(v_result->>'items_processed', '')::int, 0);
  v_error := COALESCE((v_result->>'error_occurred')::boolean, false);

  PERFORM public.complete_request_context(v_context, v_error, v_processed_steps);
  PERFORM public.update_cron_config('workflow_engine_worker');

  RETURN jsonb_build_object(
    'status', 'completed',
    'items_processed', v_processed_steps,
    'error_occurred', v_error,
    'max_steps_per_tick', v_max_steps,
    'run_result', v_result
  );
END;
$$;

COMMENT ON FUNCTION public.run_workflow_engine_worker()
  IS 'Compatibility worker tick that progresses at most one workflow run in the caller transaction.';

CREATE OR REPLACE PROCEDURE public.run_workflow_engine_worker_batch_v1()
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_throttle record;
  v_context uuid;
  v_result jsonb;
  v_processed_steps int := 0;
  v_error boolean := false;
  v_max_steps int;
  v_batch_index int;
  v_processed_run_ids uuid[] := ARRAY[]::uuid[];
  v_result_run_id uuid;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_engine_worker');
  IF NOT v_throttle.should_run THEN
    RETURN;
  END IF;

  v_max_steps := public.resolve_workflow_engine_worker_max_steps_v1();
  v_context := public.create_request_context('workflow_engine_worker');

  FOR v_batch_index IN 1..GREATEST(COALESCE(v_throttle.batch_size, 1), 1) LOOP
    v_result := public.run_workflow_engine_worker_once_v1(v_max_steps, v_processed_run_ids);

    IF COALESCE(v_result->>'status', '') = 'idle' THEN
      EXIT;
    END IF;

    v_result_run_id := NULLIF(v_result->>'workflow_run_id', '')::uuid;
    IF v_result_run_id IS NOT NULL THEN
      v_processed_run_ids := array_append(v_processed_run_ids, v_result_run_id);
    END IF;

    v_processed_steps := v_processed_steps
      + COALESCE(NULLIF(v_result->>'items_processed', '')::int, 0);
    v_error := v_error OR COALESCE((v_result->>'error_occurred')::boolean, false);

    COMMIT;
    PERFORM set_config('request.correlation_id', v_context::text, true);

    IF COALESCE((v_result->>'error_occurred')::boolean, false) THEN
      EXIT;
    END IF;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_processed_steps);
  PERFORM public.update_cron_config('workflow_engine_worker');
END;
$$;

COMMENT ON PROCEDURE public.run_workflow_engine_worker_batch_v1()
  IS 'Progress a row-driven workflow batch and commit after each run so locks never span unrelated runs.';

REVOKE ALL ON PROCEDURE public.run_workflow_engine_worker_batch_v1() FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_schedule text := '*/1 * * * *';
  v_job_id bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'workflow_engine_tick requires cron.job';
  END IF;

  SELECT jobid, schedule
  INTO v_job_id, v_schedule
  FROM cron.job
  WHERE jobname = 'workflow_engine_tick'
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule(
    'workflow_engine_tick',
    COALESCE(NULLIF(v_schedule, ''), '*/1 * * * *'),
    'CALL public.run_workflow_engine_worker_batch_v1();'
  );
END;
$$;

SELECT pg_advisory_unlock(hashtext('202608151010_workflow_worker_nonblocking_batch_v1'));
COMMIT;
