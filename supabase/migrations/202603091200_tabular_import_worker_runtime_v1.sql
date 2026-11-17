-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Tabular import worker claim/process RPCs

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091200_tabular_import_worker_runtime_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Service-only claim RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_next_tabular_import_task_v1(
  p_worker_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_task RECORD;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN OTHERS THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'claim_next_tabular_import_task_v1 requires service role context'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    t.id AS task_id,
    t.organization_id,
    t.resource_id AS run_id,
    t.queue_key,
    r.resource_key,
    r.write_mode,
    r.summary
  INTO v_task
  FROM public.tasks t
  JOIN public.task_types tt ON tt.id = t.task_type_id
  JOIN public.tabular_import_runs r ON r.id = t.resource_id
  WHERE tt.key = 'tabular_import.process'
    AND t.resource_type = 'tabular_import_run'
    AND t.status = 'queued'
    AND r.status = 'queued'
  ORDER BY t.priority DESC, t.created_at ASC
  FOR UPDATE OF t, r SKIP LOCKED
  LIMIT 1;

  IF v_task.task_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public.tabular_import_transition_task_system_v1(
    v_task.task_id,
    'in_progress',
    'tabular_import_claimed',
    jsonb_strip_nulls(jsonb_build_object('worker_id', NULLIF(btrim(COALESCE(p_worker_id, '')), ''))),
    'tabular_import_worker'
  );

  UPDATE public.tabular_import_runs
     SET status = 'processing',
         started_at = COALESCE(started_at, now()),
         updated_at = now()
   WHERE id = v_task.run_id;

  RETURN jsonb_build_object(
    'task_id', v_task.task_id,
    'run_id', v_task.run_id,
    'organization_id', v_task.organization_id,
    'resource_key', v_task.resource_key,
    'write_mode', v_task.write_mode,
    'queue_key', v_task.queue_key,
    'worker_id', NULLIF(btrim(COALESCE(p_worker_id, '')), ''),
    'summary', COALESCE(v_task.summary, '{}'::jsonb)
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 2) Service-only batch processor
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.process_tabular_import_run_v1(
  p_run_id UUID,
  p_batch_size INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_run public.tabular_import_runs%ROWTYPE;
  v_resource JSONB;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_batch_size INT := p_batch_size;
  v_row public.tabular_import_run_rows%ROWTYPE;
  v_result JSONB;
  v_target_record_id TEXT;
  v_relation TEXT;
  v_id_column TEXT;
  v_remaining INT := 0;
  v_created_count INT := 0;
  v_updated_count INT := 0;
  v_skipped_count INT := 0;
  v_failed_count INT := 0;
  v_blocked_count INT := 0;
  v_final_status TEXT := 'processing';
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN OTHERS THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'process_tabular_import_run_v1 requires service role context'
      USING ERRCODE = '42501';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'process_tabular_import_run_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id
   FOR UPDATE;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'process_tabular_import_run_v1 run % not found', p_run_id;
  END IF;
  IF v_run.status IN ('completed', 'completed_with_errors', 'failed', 'canceled') THEN
    RETURN public.ui_get_tabular_import_run_v1(v_run.id);
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_relation := COALESCE(NULLIF(btrim(COALESCE(v_resource->>'relation', '')), ''), v_run.relation_name);
  v_id_column := COALESCE(NULLIF(btrim(COALESCE(v_resource->>'id_column', '')), ''), 'id');

  SELECT *
    INTO v_policy_row
    FROM public.resolve_tabular_import_policy_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'organization_id', v_run.organization_id,
          'client_id', v_run.client_id,
          'sender_id', v_run.sender_id,
          'resource_key', v_run.resource_key
        )
      )
    )
   LIMIT 1;
  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);

  BEGIN
    v_batch_size := COALESCE(v_batch_size, NULLIF(v_policy->>'worker_batch_size', '')::int, 200);
  EXCEPTION
    WHEN OTHERS THEN
      v_batch_size := COALESCE(v_batch_size, 200);
  END;
  IF v_batch_size < 1 THEN
    v_batch_size := 1;
  END IF;

  UPDATE public.tabular_import_runs
     SET status = 'processing',
         started_at = COALESCE(started_at, now()),
         updated_at = now()
   WHERE id = v_run.id;

  FOR v_row IN
    SELECT *
    FROM public.tabular_import_run_rows
    WHERE run_id = v_run.id
      AND action IN ('create', 'update')
      AND execution_status = 'queued'
    ORDER BY row_number ASC
    LIMIT v_batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      v_result := public.tabular_import_write_row_v1(
        v_relation,
        v_id_column,
        v_row.mapped_row,
        CASE WHEN v_row.action = 'update' THEN v_row.target_record_id ELSE NULL END
      );
      v_target_record_id := COALESCE(
        NULLIF(btrim(COALESCE(v_result->>v_id_column, '')), ''),
        NULLIF(btrim(COALESCE(v_row.target_record_id, '')), '')
      );

      UPDATE public.tabular_import_run_rows
         SET execution_status = 'succeeded',
             processed_at = now(),
             target_record_id = v_target_record_id,
             updated_at = now()
       WHERE id = v_row.id;
    EXCEPTION
      WHEN OTHERS THEN
        UPDATE public.tabular_import_run_rows
           SET action = 'failed',
               execution_status = 'failed',
               processed_at = now(),
               diagnostics = COALESCE(diagnostics, '[]'::jsonb) || jsonb_build_array(
                 jsonb_build_object(
                   'level', 'error',
                   'blocking', TRUE,
                   'code', 'execution_failed',
                   'message', format('Row %s failed during execution.', v_row.row_number),
                   'why', SQLERRM,
                   'recommended_fix', 'Review the row error export or fix the target data shape before retrying.'
                 )
               ),
               reason_codes = COALESCE(reason_codes, '[]'::jsonb) || jsonb_build_array('execution_failed'),
               reason_messages = COALESCE(reason_messages, '[]'::jsonb) || jsonb_build_array(SQLERRM),
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('execution_error', SQLERRM),
               updated_at = now()
         WHERE id = v_row.id;
    END;
  END LOOP;

  SELECT count(*)
    INTO v_remaining
    FROM public.tabular_import_run_rows
   WHERE run_id = v_run.id
     AND action IN ('create', 'update')
     AND execution_status = 'queued';

  SELECT
    count(*) FILTER (WHERE action = 'create' AND execution_status = 'succeeded'),
    count(*) FILTER (WHERE action = 'update' AND execution_status = 'succeeded'),
    count(*) FILTER (WHERE action = 'skip' OR execution_status = 'skipped'),
    count(*) FILTER (WHERE action = 'failed' OR execution_status = 'failed'),
    count(*) FILTER (WHERE action = 'block' OR execution_status = 'blocked')
  INTO
    v_created_count,
    v_updated_count,
    v_skipped_count,
    v_failed_count,
    v_blocked_count
  FROM public.tabular_import_run_rows
  WHERE run_id = v_run.id;

  IF v_remaining > 0 THEN
    v_final_status := 'processing';
  ELSIF v_failed_count > 0 OR v_blocked_count > 0 OR v_skipped_count > 0 THEN
    v_final_status := 'completed_with_errors';
  ELSE
    v_final_status := 'completed';
  END IF;

  UPDATE public.tabular_import_runs
     SET status = v_final_status,
         created_count = v_created_count,
         updated_count = v_updated_count,
         skipped_count = v_skipped_count,
         failed_count = v_failed_count,
         blocked_count = v_blocked_count,
         completed_at = CASE WHEN v_remaining = 0 THEN now() ELSE completed_at END,
         updated_at = now()
   WHERE id = v_run.id;

  IF v_remaining = 0 AND v_run.task_id IS NOT NULL THEN
    PERFORM public.tabular_import_transition_task_system_v1(
      v_run.task_id,
      'completed',
      CASE WHEN v_final_status = 'completed_with_errors' THEN 'completed_with_errors' ELSE 'completed' END,
      jsonb_build_object(
        'run_id', v_run.id,
        'status', v_final_status,
        'created_count', v_created_count,
        'updated_count', v_updated_count,
        'skipped_count', v_skipped_count,
        'failed_count', v_failed_count,
        'blocked_count', v_blocked_count
      ),
      'tabular_import_worker'
    );
  END IF;

  RETURN jsonb_build_object(
    'run_id', v_run.id,
    'status', v_final_status,
    'remaining', v_remaining,
    'created_count', v_created_count,
    'updated_count', v_updated_count,
    'skipped_count', v_skipped_count,
    'failed_count', v_failed_count,
    'blocked_count', v_blocked_count
  );
EXCEPTION
  WHEN OTHERS THEN
    IF v_run.id IS NOT NULL THEN
      UPDATE public.tabular_import_runs
         SET status = 'failed',
             completed_at = now(),
             updated_at = now(),
             summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('fatal_error', SQLERRM)
       WHERE id = v_run.id;

      IF v_run.task_id IS NOT NULL THEN
        PERFORM public.tabular_import_transition_task_system_v1(
          v_run.task_id,
          'failed',
          'tabular_import_failed',
          jsonb_build_object('run_id', v_run.id, 'error', SQLERRM),
          'tabular_import_worker'
        );
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'run_id', p_run_id,
      'status', 'failed',
      'error', SQLERRM
    );
END;
$function$;

COMMENT ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) IS
  'Service-only worker claim RPC for queued tabular_import.process tasks.';

COMMENT ON FUNCTION public.process_tabular_import_run_v1(UUID, INT) IS
  'Service-only batch processor for staged tabular import runs. Writes create/update rows and updates run/task projections.';

REVOKE ALL ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.process_tabular_import_run_v1(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_tabular_import_run_v1(UUID, INT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603091200_tabular_import_worker_runtime_v1'));
COMMIT;
