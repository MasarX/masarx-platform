-- Plan: PLAN-202603-resource-import-related-node-graph / Step: S04
-- Migration: Use a service-safe run snapshot for worker/process return paths

BEGIN;

SELECT pg_advisory_lock(hashtext('202603111150_tabular_import_process_system_snapshot_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.tabular_import_get_run_system_v1(
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_artifacts JSONB := '[]'::jsonb;
  v_rows JSONB := '[]'::jsonb;
  v_report JSONB := NULL;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_get_run_system_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_get_run_system_v1 run % not found', p_run_id;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'artifact_id', a.id,
          'relation_type', link.relation_type,
          'storage_bucket', a.storage_bucket,
          'storage_key', a.storage_key,
          'mime_type', a.mime_type,
          'file_name', COALESCE(NULLIF(btrim(COALESCE(a.metadata->>'file_name', '')), ''), split_part(a.storage_key, '/', array_length(string_to_array(a.storage_key, '/'), 1))),
          'metadata', a.metadata
        )
      )
      ORDER BY link.created_at ASC
    ),
    '[]'::jsonb
  )
    INTO v_artifacts
    FROM public.artifact_links link
    JOIN public.artifacts a ON a.id = link.artifact_id
   WHERE link.organization_id = v_run.organization_id
     AND link.resource_type = 'tabular_import_runs'
     AND link.resource_id = v_run.id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'row_number', row_number,
          'execution_status', execution_status,
          'action', action,
          'diagnostics', diagnostics,
          'coercions', coercions,
          'original_row', original_row,
          'mapped_row', mapped_row,
          'target_record_id', target_record_id,
          'reason_codes', reason_codes,
          'reason_messages', reason_messages,
          'related_nodes', COALESCE(metadata->'related_nodes', '[]'::jsonb)
        )
      )
      ORDER BY row_number ASC
    ),
    '[]'::jsonb
  )
    INTO v_rows
    FROM (
      SELECT *
      FROM public.tabular_import_run_rows
      WHERE run_id = v_run.id
      ORDER BY row_number ASC
      LIMIT 25
    ) sample_rows;

  IF v_run.report_id IS NOT NULL THEN
    SELECT to_jsonb(r.*)
      INTO v_report
      FROM public.mapping_operation_reports r
     WHERE r.id = v_run.report_id;
  END IF;

  RETURN jsonb_strip_nulls(
    to_jsonb(v_run) || jsonb_build_object(
      'artifacts', COALESCE(v_artifacts, '[]'::jsonb),
      'rows', COALESCE(v_rows, '[]'::jsonb),
      'report', v_report
    )
  );
END;
$function$;

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
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_batch_size INT := p_batch_size;
  v_row public.tabular_import_run_rows%ROWTYPE;
  v_result JSONB;
  v_report JSONB;
  v_report_id UUID;
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
    RETURN public.tabular_import_get_run_system_v1(v_run.id);
  END IF;

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
      v_result := public.tabular_import_execute_row_graph_v1(v_run.id, v_row.id);

      UPDATE public.tabular_import_run_rows
         SET execution_status = 'succeeded',
             processed_at = now(),
             mapped_row = COALESCE(v_result->'mapped_row', mapped_row),
             target_record_id = NULLIF(btrim(COALESCE(v_result->>'target_record_id', '')), ''),
             metadata = jsonb_strip_nulls(
               COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'related_nodes', COALESCE(v_result->'related_nodes', '[]'::jsonb),
                 'primary_result', COALESCE(v_result->'primary_result', '{}'::jsonb)
               )
             ),
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
                   'recommended_fix', 'Review the row error export or fix the staged related-node/primary payload before retrying.'
                 )
               ),
               reason_codes = COALESCE(reason_codes, '[]'::jsonb) || jsonb_build_array('execution_failed'),
               reason_messages = COALESCE(reason_messages, '[]'::jsonb) || jsonb_build_array(SQLERRM),
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('execution_error', SQLERRM),
               updated_at = now()
         WHERE id = v_row.id;
    END;
  END LOOP;

  PERFORM public.tabular_import_refresh_run_rollups_v1(v_run.id);

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

  IF v_remaining = 0 AND v_run.report_id IS NULL THEN
    v_report := public.ui_create_mapping_operation_report_v1(
      jsonb_build_object(
        'organization_id', v_run.organization_id,
        'artifact_type', 'tabular_import',
        'operation_kind', 'tabular_import_execution',
        'save_mode', 'direct',
        'status', CASE WHEN v_final_status = 'completed' THEN 'succeeded' ELSE 'failed' END,
        'primary_resource_type', 'tabular_import_runs',
        'primary_resource_id', v_run.id,
        'request_summary', jsonb_strip_nulls(
          jsonb_build_object(
            'resource_key', v_run.resource_key,
            'relation_name', v_run.relation_name,
            'write_mode', v_run.write_mode,
            'profile_name', v_run.profile_name
          )
        ),
        'result_payload', jsonb_strip_nulls(
          jsonb_build_object(
            'run_id', v_run.id,
            'status', v_final_status,
            'created_count', v_created_count,
            'updated_count', v_updated_count,
            'skipped_count', v_skipped_count,
            'failed_count', v_failed_count,
            'blocked_count', v_blocked_count
          )
        ),
        'created_by', v_run.created_by,
        'updated_by', v_run.updated_by
      )
    );
    v_report_id := public.mapping_studio_try_uuid_v1(v_report->>'id');

    IF v_report_id IS NULL THEN
      RAISE EXCEPTION 'tabular_import report creation returned an invalid id for run %', v_run.id;
    END IF;

    UPDATE public.tabular_import_runs
       SET report_id = v_report_id,
           updated_at = now()
     WHERE id = v_run.id;
  END IF;

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

  RETURN public.tabular_import_get_run_system_v1(v_run.id);
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

COMMENT ON FUNCTION public.tabular_import_get_run_system_v1(UUID) IS
  'Return the canonical tabular import run snapshot for service-role execution paths without UI capability gating.';

REVOKE ALL ON FUNCTION public.tabular_import_get_run_system_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_get_run_system_v1(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.process_tabular_import_run_v1(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_tabular_import_run_v1(UUID, INT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603111150_tabular_import_process_system_snapshot_v1'));

COMMIT;
