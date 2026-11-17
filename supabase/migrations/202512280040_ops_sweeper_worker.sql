-- Plan: PLAN-202512-unified-jobs-maintenance / Step: S04
-- Migration: Ops sweeper worker (self-healing maintenance)
-- Purpose:
--   - Add a universal, policy-driven ops sweeper that ensures critical pg_cron jobs exist and match SSOT.
--   - Keep behavior row-driven via settings (ops_sweeper_policy) and safe dynamic dispatch via operation_handlers.
-- Date: 2025-12-28

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1) Task handler: ensure cron jobs exist (row-driven)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ops_sweeper_ensure_cron_jobs(p_task JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_jobs JSONB;
  v_job JSONB;

  v_enabled BOOLEAN := TRUE;
  v_jobname TEXT;
  v_schedule TEXT;
  v_worker_name TEXT;

  v_function_schema TEXT;
  v_function_name TEXT;
  v_call_style TEXT;

  v_args JSONB;
  v_arg_types JSONB;
  v_arg_type_list TEXT[];

  v_sig TEXT;
  v_proc REGPROCEDURE;
  v_args_sql TEXT;
  v_command TEXT;

  v_created INT := 0;
  v_updated INT := 0;
  v_unchanged INT := 0;
  v_skipped INT := 0;
  v_errors INT := 0;

  v_cron RECORD;
  v_len INT;
  v_idx INT;
  v_type TEXT;
  v_val JSONB;
  v_expr TEXT;
  v_exprs TEXT[];
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'pg_cron_not_installed');
  END IF;

  v_jobs := p_task #> '{arguments,jobs}';
  IF v_jobs IS NULL OR jsonb_typeof(v_jobs) <> 'array' THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'missing_jobs_array');
  END IF;

  FOR v_job IN
    SELECT value FROM jsonb_array_elements(v_jobs)
  LOOP
    BEGIN
      v_enabled := TRUE;
      BEGIN
        v_enabled := COALESCE(NULLIF(v_job->>'enabled', '')::BOOLEAN, TRUE);
      EXCEPTION WHEN OTHERS THEN
        v_enabled := TRUE;
      END;
      IF NOT v_enabled THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_jobname := NULLIF(btrim(v_job->>'jobname'), '');
      IF v_jobname IS NULL THEN
        v_errors := v_errors + 1;
        CONTINUE;
      END IF;

      v_worker_name := NULLIF(btrim(v_job->>'worker_name'), '');
      v_schedule := NULLIF(btrim(v_job->>'schedule'), '');

      IF v_schedule IS NULL AND v_worker_name IS NOT NULL THEN
        SELECT wr.schedule
          INTO v_schedule
          FROM public.worker_registry wr
         WHERE wr.worker_name = v_worker_name
         LIMIT 1;
        v_schedule := NULLIF(btrim(v_schedule), '');
      END IF;

      IF v_schedule IS NULL THEN
        v_errors := v_errors + 1;
        CONTINUE;
      END IF;

      v_function_schema := COALESCE(NULLIF(btrim(v_job->>'function_schema'), ''), 'public');
      v_function_name := NULLIF(btrim(v_job->>'function_name'), '');
      IF v_function_name IS NULL AND v_worker_name IS NOT NULL THEN
        v_function_schema := 'public';
        v_function_name := 'run_' || v_worker_name;
      END IF;
      IF v_function_name IS NULL THEN
        v_errors := v_errors + 1;
        CONTINUE;
      END IF;

      v_call_style := lower(COALESCE(NULLIF(btrim(v_job->>'call_style'), ''), 'select'));
      IF v_call_style NOT IN ('select', 'select_from') THEN
        v_call_style := 'select';
      END IF;

      v_args := COALESCE(v_job->'args', '[]'::jsonb);
      IF jsonb_typeof(v_args) <> 'array' THEN
        v_args := '[]'::jsonb;
      END IF;

      v_arg_types := COALESCE(v_job->'arg_types', '[]'::jsonb);
      IF jsonb_typeof(v_arg_types) <> 'array' THEN
        v_arg_types := '[]'::jsonb;
      END IF;

      IF jsonb_array_length(v_args) <> jsonb_array_length(v_arg_types) THEN
        v_errors := v_errors + 1;
        CONTINUE;
      END IF;

      v_arg_type_list := ARRAY[]::text[];
      IF jsonb_array_length(v_arg_types) > 0 THEN
        SELECT array_agg(value)
          INTO v_arg_type_list
          FROM jsonb_array_elements_text(v_arg_types) a(value);
      END IF;
      IF v_arg_type_list IS NULL THEN
        v_arg_type_list := ARRAY[]::text[];
      END IF;

      v_sig := CASE
        WHEN COALESCE(array_length(v_arg_type_list, 1), 0) = 0 THEN '()'
        ELSE '(' || array_to_string(v_arg_type_list, ',') || ')'
      END;

      v_proc := to_regprocedure(format('%I.%I%s', v_function_schema, v_function_name, v_sig));
      IF v_proc IS NULL THEN
        v_errors := v_errors + 1;
        CONTINUE;
      END IF;

      v_args_sql := '';
      v_len := jsonb_array_length(v_args);
      IF v_len > 0 THEN
        v_exprs := ARRAY[]::text[];
        FOR v_idx IN 0..(v_len - 1) LOOP
          v_val := v_args->v_idx;
          v_type := v_arg_type_list[v_idx + 1];

          IF v_type IS NULL OR NOT (v_type ~ '^[a-z_][a-z0-9_]*(\\.[a-z_][a-z0-9_]*)?$') THEN
            v_errors := v_errors + 1;
            v_exprs := NULL;
            EXIT;
          END IF;

          IF v_val IS NULL OR v_val = 'null'::jsonb THEN
            v_expr := format('NULL::%s', v_type);
          ELSIF jsonb_typeof(v_val) IN ('number', 'boolean') THEN
            v_expr := format('%s::%s', v_val::text, v_type);
          ELSIF jsonb_typeof(v_val) = 'string' THEN
            v_expr := format('%L::%s', v_val #>> '{}', v_type);
          ELSE
            v_expr := format('%L::%s', v_val::text, v_type);
          END IF;

          v_exprs := v_exprs || v_expr;
        END LOOP;

        IF v_exprs IS NULL THEN
          CONTINUE;
        END IF;

        v_args_sql := array_to_string(v_exprs, ',');
      END IF;

      IF v_call_style = 'select_from' THEN
        v_command := format('SELECT * FROM %I.%I(%s);', v_function_schema, v_function_name, v_args_sql);
      ELSE
        v_command := format('SELECT %I.%I(%s);', v_function_schema, v_function_name, v_args_sql);
      END IF;

      SELECT j.jobid, j.schedule, j.command
        INTO v_cron
        FROM cron.job j
       WHERE j.jobname = v_jobname
       LIMIT 1;

      IF FOUND THEN
        IF COALESCE(v_cron.schedule, '') = v_schedule
           AND COALESCE(v_cron.command, '') = v_command THEN
          v_unchanged := v_unchanged + 1;
        ELSE
          PERFORM cron.unschedule(v_jobname);
          PERFORM cron.schedule(v_jobname, v_schedule, v_command);
          v_updated := v_updated + 1;
        END IF;
      ELSE
        PERFORM cron.schedule(v_jobname, v_schedule, v_command);
        v_created := v_created + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      CONTINUE;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'completed',
    'created', v_created,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'skipped', v_skipped,
    'errors', v_errors
  );
END;
$$;

COMMENT ON FUNCTION public.ops_sweeper_ensure_cron_jobs(JSONB)
  IS 'Ensure critical pg_cron jobs exist and match the configured schedule/command (policy-driven).';

-- ---------------------------------------------------------------------------
-- 2) Worker: run_ops_sweeper_worker (policy-driven)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.run_ops_sweeper_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_tasks_executed INT := 0;
  v_error_occurred BOOLEAN := FALSE;

  v_policy JSONB;
  v_enabled BOOLEAN := FALSE;
  v_tasks JSONB;
  v_task JSONB;

  v_handler_key TEXT;
  v_handler RECORD;
  v_result JSONB;
  v_results JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('ops_sweeper_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('ops_sweeper_worker');

  v_policy := public.resolve_settings('ops_sweeper_policy', 'global', NULL);
  v_enabled := FALSE;
  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION WHEN OTHERS THEN
    v_enabled := FALSE;
  END;

  IF NOT v_enabled THEN
    PERFORM public.complete_request_context(v_context, FALSE, 0);
    PERFORM public.update_cron_config('ops_sweeper_worker');
    RETURN json_build_object('status', 'disabled');
  END IF;

  v_tasks := CASE
    WHEN jsonb_typeof(v_policy->'tasks') = 'array' THEN v_policy->'tasks'
    ELSE '[]'::jsonb
  END;

  FOR v_task IN
    SELECT value FROM jsonb_array_elements(v_tasks)
  LOOP
    BEGIN
      IF COALESCE(NULLIF(v_task->>'enabled', '')::BOOLEAN, TRUE) IS NOT TRUE THEN
        CONTINUE;
      END IF;

      v_handler_key := NULLIF(btrim(v_task->>'handler_key'), '');
      IF v_handler_key IS NULL THEN
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'status', 'skipped',
          'reason', 'missing_handler_key'
        ));
        CONTINUE;
      END IF;

      SELECT handler_key, handler_schema, handler_name, handler_signature, handler_version
        INTO v_handler
        FROM public.operation_handlers
       WHERE handler_key = v_handler_key
         AND is_active = TRUE;

      IF NOT FOUND THEN
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'handler_key', v_handler_key,
          'status', 'skipped',
          'reason', 'handler_not_registered'
        ));
        CONTINUE;
      END IF;

      IF COALESCE(v_handler.handler_signature, '') <> '(jsonb)' THEN
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'handler_key', v_handler_key,
          'status', 'skipped',
          'reason', 'unsupported_handler_signature',
          'signature', v_handler.handler_signature
        ));
        CONTINUE;
      END IF;

      EXECUTE format('SELECT %I.%I($1)', v_handler.handler_schema, v_handler.handler_name)
      INTO v_result
      USING v_task;

      v_tasks_executed := v_tasks_executed + 1;
      v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'handler_key', v_handler_key,
        'handler_version', v_handler.handler_version,
        'result', v_result
      )));
    EXCEPTION WHEN OTHERS THEN
      v_error_occurred := TRUE;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'handler_key', COALESCE(v_handler_key, '<unknown>'),
        'status', 'error',
        'error', SQLERRM
      ));
      CONTINUE;
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error_occurred, v_tasks_executed);
  PERFORM public.update_cron_config('ops_sweeper_worker');

  RETURN json_build_object(
    'status', 'completed',
    'tasks_executed', v_tasks_executed,
    'error_occurred', v_error_occurred,
    'results', v_results
  );
EXCEPTION WHEN OTHERS THEN
  v_error_occurred := TRUE;
  PERFORM public.complete_request_context(v_context, TRUE, v_tasks_executed);
  PERFORM public.update_cron_config('ops_sweeper_worker');
  RETURN json_build_object('status', 'failed', 'error', SQLERRM);
END;
$$;

ALTER FUNCTION public.run_ops_sweeper_worker()
  SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 3) Register handler(s) in operation_handlers (safe dynamic dispatch)
-- ---------------------------------------------------------------------------

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  created_by,
  notes,
  doc_url
)
VALUES (
  'ops_sweeper_ensure_cron_jobs',
  'public',
  'ops_sweeper_ensure_cron_jobs',
  '(jsonb)',
  'v1',
  TRUE,
  NULL,
  'Ensure critical pg_cron jobs exist and match the configured schedule/command (policy-driven).',
  'docs/ops/runbooks/ops_sweeper_worker.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET
  handler_schema = EXCLUDED.handler_schema,
  handler_name = EXCLUDED.handler_name,
  handler_signature = EXCLUDED.handler_signature,
  handler_version = EXCLUDED.handler_version,
  is_active = EXCLUDED.is_active,
  notes = EXCLUDED.notes,
  doc_url = EXCLUDED.doc_url,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 4) Seed default global policy (do not override if already configured)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_version_id UUID;
  v_existing_value JSONB;
  v_value JSONB := jsonb_build_object(
    'enabled', TRUE,
    'tasks', jsonb_build_array(
      jsonb_build_object(
        'task_key', 'ensure_cron_jobs',
        'enabled', TRUE,
        'handler_key', 'ops_sweeper_ensure_cron_jobs',
        'arguments', jsonb_build_object(
          'jobs', jsonb_build_array(
            -- Worker ticks (cadence from worker_registry.schedule; custom jobname supported)
            jsonb_build_object('jobname', 'outbound_worker_tick', 'worker_name', 'outbound_worker'),
            jsonb_build_object('jobname', 'webhook_processor_worker_tick', 'worker_name', 'webhook_processor_worker'),
            jsonb_build_object('jobname', 'domain_events_worker_tick', 'worker_name', 'domain_events_worker'),
            jsonb_build_object('jobname', 'cache_cleanup_worker_tick', 'worker_name', 'cache_cleanup_worker'),
            jsonb_build_object('jobname', 'campaign_enrollment_worker_tick', 'worker_name', 'campaign_enrollment_worker'),
            jsonb_build_object('jobname', 'campaign_dispatcher_worker_tick', 'worker_name', 'campaign_dispatcher_worker'),
            jsonb_build_object('jobname', 'circuit_breaker_recovery_worker_tick', 'worker_name', 'circuit_breaker_recovery_worker'),
            jsonb_build_object('jobname', 'alert_dispatch_tick', 'worker_name', 'alert_dispatch_worker'),
            jsonb_build_object('jobname', 'ops_cron_health_tick', 'worker_name', 'ops_cron_health_worker'),
            jsonb_build_object('jobname', 'ops_queue_health_tick', 'worker_name', 'ops_queue_health_worker'),

            -- Non-worker cron jobs (cadence/args defined here)
            jsonb_build_object(
              'jobname', 'edge_requeue_expired_jobs',
              'schedule', '*/1 * * * *',
              'function_schema', 'public',
              'function_name', 'requeue_expired_edge_jobs',
              'call_style', 'select',
              'arg_types', jsonb_build_array('integer'),
              'args', jsonb_build_array(500)
            ),
            jsonb_build_object(
              'jobname', 'label_jobs_reclaim',
              'schedule', '*/5 * * * *',
              'function_schema', 'public',
              'function_name', 'reclaim_stale_label_jobs',
              'call_style', 'select',
              'arg_types', jsonb_build_array('integer', 'integer'),
              'args', jsonb_build_array(500, 600)
            ),
            jsonb_build_object(
              'jobname', 'partition_create_next',
              'schedule', '0 0 * * 1',
              'function_schema', 'public',
              'function_name', 'create_next_partitions',
              'call_style', 'select_from',
              'arg_types', '[]'::jsonb,
              'args', '[]'::jsonb
            ),
            jsonb_build_object(
              'jobname', 'partition_apply_index_templates',
              'schedule', '5 0 * * 1',
              'function_schema', 'public',
              'function_name', 'apply_partition_index_templates',
              'call_style', 'select_from',
              'arg_types', '[]'::jsonb,
              'args', '[]'::jsonb
            ),
            jsonb_build_object(
              'jobname', 'audit_ensure_triggers',
              'schedule', '10 0 * * 1',
              'function_schema', 'public',
              'function_name', 'ensure_audit_triggers',
              'call_style', 'select_from',
              'arg_types', '[]'::jsonb,
              'args', '[]'::jsonb
            ),
            jsonb_build_object(
              'jobname', 'partition_archive_old',
              'schedule', '0 1 1 * *',
              'function_schema', 'public',
              'function_name', 'archive_old_partitions',
              'call_style', 'select_from',
              'arg_types', '[]'::jsonb,
              'args', '[]'::jsonb
            )
          )
        )
      )
    )
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ops_sweeper_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

  SELECT sv.id
    INTO v_version_id
    FROM public.settings_versions sv
   WHERE sv.category = 'ops_sweeper_policy'
     AND sv.scope_type = 'global'
     AND sv.scope_hash = v_scope_hash
     AND sv.effective_until IS NULL
   ORDER BY sv.approved_at DESC NULLS LAST, sv.created_at DESC
   LIMIT 1;

  IF v_version_id IS NULL THEN
    v_version_id := gen_random_uuid();
    INSERT INTO public.settings_versions (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    )
    VALUES (
      v_version_id,
      'ops_sweeper_policy',
      'global',
      NULL,
      v_scope_hash,
      1,
      v_value,
      1,
      'Seed ops_sweeper_policy defaults',
      now(),
      now()
    );
  ELSE
    SELECT sv.value
      INTO v_existing_value
      FROM public.settings_versions sv
     WHERE sv.id = v_version_id
       AND sv.scope_hash = v_scope_hash
     LIMIT 1;
  END IF;

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'ops_sweeper_policy',
    'global',
    NULL,
    v_scope_hash,
    v_version_id,
    COALESCE(v_existing_value, v_value),
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Worker registry + cron_config baseline + pg_cron schedule
-- ---------------------------------------------------------------------------

INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'ops_sweeper_worker',
  'monitoring',
  'Universal ops sweeper: ensures critical cron jobs exist and self-heals missing schedules (policy-driven).',
  '*/5 * * * *',
  jsonb_build_object('policy_category', 'ops_sweeper_policy'),
  TRUE
)
ON CONFLICT (worker_name) DO UPDATE
SET
  worker_type = EXCLUDED.worker_type,
  description = EXCLUDED.description,
  schedule = EXCLUDED.schedule,
  config = EXCLUDED.config,
  is_active = TRUE,
  updated_at = now();

INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
  'ops_sweeper_worker',
  300,
  50,
  TRUE,
  'Ops sweeper (settings: ops_sweeper_policy). Ensures critical pg_cron jobs exist and match SSOT.'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = TRUE,
  notes = EXCLUDED.notes;

DO $$
DECLARE
  v_schedule TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ops_sweeper_tick') THEN
    PERFORM cron.unschedule('ops_sweeper_tick');
  END IF;

  SELECT schedule
    INTO v_schedule
    FROM public.worker_registry
   WHERE worker_name = 'ops_sweeper_worker'
   LIMIT 1;

  v_schedule := COALESCE(NULLIF(btrim(v_schedule), ''), '*/5 * * * *');

  PERFORM cron.schedule(
    'ops_sweeper_tick',
    v_schedule,
    'SELECT public.run_ops_sweeper_worker();'
  );
END $$;

COMMIT;
