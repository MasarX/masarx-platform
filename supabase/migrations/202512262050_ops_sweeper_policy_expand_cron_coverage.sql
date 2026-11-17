-- Plan: PLAN-202512-unified-jobs-maintenance / Step: S95
-- Migration: Ops sweeper policy - expand cron coverage
-- Purpose:
--   - Expand ops_sweeper_policy defaults to cover additional critical cron jobs (geocoding + alert aggregation).
--   - Add a dedicated label renderer cron guard task so conditional scheduling stays correct over time.
-- Date: 2025-12-26

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1) Task handler: label renderer cron guard (conditional scheduling)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ops_sweeper_label_renderer_cron_guard(p_task JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_config JSONB;
  v_provider JSONB;
  v_placeholder BOOLEAN := TRUE;

  v_schedule TEXT;
  v_batch_size INT;
  v_command TEXT;
  v_action TEXT := NULL;

  v_cron RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'pg_cron_not_installed');
  END IF;

  v_config := public.resolve_settings('label_provider', 'global', NULL);

  v_placeholder := TRUE;
  IF v_config IS NOT NULL THEN
    v_provider := v_config->'providers'->0;
    IF v_provider IS NOT NULL THEN
      v_placeholder := (v_provider->>'invoke_url' IS NULL OR v_provider->>'invoke_url' = 'https://example.supabase.co/functions/v1/label-renderer' /* objectives:allow SUPABASE_URL Justification: placeholder sentinel, not an actual endpoint */ )
        OR (v_provider->>'invoke_secret' IS NULL OR v_provider->>'invoke_secret' = 'EXAMPLE_PASSWORD');
    END IF;
  END IF;

  IF v_placeholder THEN
    UPDATE public.cron_config
       SET enabled = FALSE,
           notes = 'Auto-dispatch label renderer via invoke_label_renderer(); enable after invoke_url/invoke_secret rotated'
     WHERE worker_name = 'label_job_renderer';

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'label_renderer_dispatch') THEN
      PERFORM cron.unschedule('label_renderer_dispatch');
      v_action := 'unscheduled';
    ELSE
      v_action := 'already_unscheduled';
    END IF;

    RETURN jsonb_build_object(
      'status', 'disabled',
      'reason', 'label_provider_invoke_configuration_placeholder',
      'action', v_action
    );
  END IF;

  IF to_regprocedure('public.invoke_label_renderer(integer)') IS NULL THEN
    UPDATE public.cron_config
       SET enabled = FALSE,
           notes = 'Auto-dispatch label renderer disabled: invoke_label_renderer(int) missing'
     WHERE worker_name = 'label_job_renderer';

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'label_renderer_dispatch') THEN
      PERFORM cron.unschedule('label_renderer_dispatch');
      v_action := 'unscheduled';
    ELSE
      v_action := 'already_unscheduled';
    END IF;

    RETURN jsonb_build_object(
      'status', 'disabled',
      'reason', 'invoke_label_renderer_missing',
      'action', v_action
    );
  END IF;

  UPDATE public.cron_config
     SET enabled = TRUE,
         notes = 'Auto-dispatch label renderer via invoke_label_renderer(); enabled (invoke configuration present)'
   WHERE worker_name = 'label_job_renderer';

  SELECT wr.schedule
    INTO v_schedule
    FROM public.worker_registry wr
   WHERE wr.worker_name = 'label_job_renderer'
   LIMIT 1;

  v_schedule := COALESCE(NULLIF(btrim(v_schedule), ''), '*/1 * * * *');

  SELECT c.batch_size
    INTO v_batch_size
    FROM public.cron_config c
   WHERE c.worker_name = 'label_job_renderer'
   LIMIT 1;

  v_batch_size := GREATEST(COALESCE(v_batch_size, 10), 1);
  v_command := format('SELECT public.invoke_label_renderer(%s);', v_batch_size);

  SELECT j.jobid, j.schedule, j.command
    INTO v_cron
    FROM cron.job j
   WHERE j.jobname = 'label_renderer_dispatch'
   LIMIT 1;

  IF FOUND THEN
    IF COALESCE(v_cron.schedule, '') = v_schedule
       AND COALESCE(v_cron.command, '') = v_command THEN
      v_action := 'unchanged';
    ELSE
      PERFORM cron.unschedule('label_renderer_dispatch');
      PERFORM cron.schedule('label_renderer_dispatch', v_schedule, v_command);
      v_action := 'updated';
    END IF;
  ELSE
    PERFORM cron.schedule('label_renderer_dispatch', v_schedule, v_command);
    v_action := 'created';
  END IF;

  RETURN jsonb_build_object(
    'status', 'enabled',
    'action', v_action,
    'schedule', v_schedule,
    'command', v_command
  );
END;
$$;

COMMENT ON FUNCTION public.ops_sweeper_label_renderer_cron_guard(JSONB)
  IS 'Keep label_renderer_dispatch cron scheduling aligned to label_provider invoke configuration (no placeholders).';

-- Register handler for ops sweeper dynamic dispatch.
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
  'ops_sweeper_label_renderer_cron_guard',
  'public',
  'ops_sweeper_label_renderer_cron_guard',
  '(jsonb)',
  'v1',
  TRUE,
  NULL,
  'Ensure label_renderer_dispatch cron job is enabled only when label_provider invoke configuration is active (no placeholders).',
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
-- 2) Patch: ops_sweeper_policy defaults (append missing jobs/tasks only)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings RECORD;
  v_current JSONB;
  v_tasks JSONB;
  v_next_tasks JSONB := '[]'::jsonb;
  v_task JSONB;
  v_has_ensure BOOLEAN := FALSE;
  v_has_label_guard BOOLEAN := FALSE;

  v_jobs JSONB;
  v_next_jobs JSONB;
  v_required_jobs JSONB := jsonb_build_array(
    -- Geocoding maintenance (stuck steps + manual review SLA + cache cleanup)
    jsonb_build_object(
      'jobname', 'geocoding_reclaim_in_progress',
      'schedule', '*/10 * * * *',
      'function_schema', 'public',
      'function_name', 'requeue_stuck_geocoding_steps',
      'call_style', 'select',
      'arg_types', jsonb_build_array('integer', 'integer'),
      'args', jsonb_build_array(500, 300)
    ),
    jsonb_build_object(
      'jobname', 'geocoding_manual_review_escalate',
      'schedule', '*/15 * * * *',
      'function_schema', 'public',
      'function_name', 'escalate_geocoding_manual_review',
      'call_style', 'select',
      'arg_types', jsonb_build_array('integer'),
      'args', jsonb_build_array(200)
    ),
    jsonb_build_object(
      'jobname', 'geocoding_cache_cleanup',
      'schedule', '0 * * * *',
      'function_schema', 'public',
      'function_name', 'cleanup_expired_geocodes',
      'call_style', 'select',
      'arg_types', jsonb_build_array('integer'),
      'args', jsonb_build_array(1000)
    ),

    -- Alert aggregation tick (cadence from worker_registry.schedule; worker self-throttles via cron_config)
    jsonb_build_object('jobname', 'alert_aggregation_tick', 'worker_name', 'alert_aggregation_worker')
  );

  v_req JSONB;
  v_next JSONB;
  v_prev_version INT := 0;
  v_new_version INT := 1;
  v_new_version_id UUID;
BEGIN
  SELECT s.settings_version_id, s.cached_value
  INTO v_settings
  FROM public.settings s
  WHERE s.category = 'ops_sweeper_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  ORDER BY s.last_updated DESC
  LIMIT 1;

  IF v_settings.settings_version_id IS NULL THEN
    -- Policy not present (seed migration will handle).
    RETURN;
  END IF;

  v_current := COALESCE(v_settings.cached_value, '{}'::jsonb);
  v_tasks := CASE WHEN jsonb_typeof(v_current->'tasks') = 'array' THEN v_current->'tasks' ELSE '[]'::jsonb END;

  FOR v_task IN SELECT value FROM jsonb_array_elements(v_tasks) LOOP
    IF COALESCE(v_task->>'task_key', '') = 'ensure_cron_jobs' THEN
      v_has_ensure := TRUE;
      v_jobs := CASE WHEN jsonb_typeof(v_task#>'{arguments,jobs}') = 'array' THEN v_task#>'{arguments,jobs}' ELSE '[]'::jsonb END;
      v_next_jobs := v_jobs;

      FOR v_req IN SELECT value FROM jsonb_array_elements(v_required_jobs) LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_next_jobs) e
          WHERE COALESCE(e->>'jobname', '') = COALESCE(v_req->>'jobname', '')
        ) THEN
          v_next_jobs := v_next_jobs || jsonb_build_array(v_req);
        END IF;
      END LOOP;

      v_task := jsonb_set(v_task, '{arguments,jobs}', v_next_jobs, TRUE);
    END IF;

    IF COALESCE(v_task->>'task_key', '') = 'label_renderer_cron_guard'
       OR COALESCE(v_task->>'handler_key', '') = 'ops_sweeper_label_renderer_cron_guard' THEN
      v_has_label_guard := TRUE;
    END IF;

    v_next_tasks := v_next_tasks || jsonb_build_array(v_task);
  END LOOP;

  IF NOT v_has_ensure THEN
    v_next_tasks := v_next_tasks || jsonb_build_array(jsonb_build_object(
      'task_key', 'ensure_cron_jobs',
      'enabled', TRUE,
      'handler_key', 'ops_sweeper_ensure_cron_jobs',
      'arguments', jsonb_build_object('jobs', v_required_jobs)
    ));
  END IF;

  IF NOT v_has_label_guard THEN
    v_next_tasks := v_next_tasks || jsonb_build_array(jsonb_build_object(
      'task_key', 'label_renderer_cron_guard',
      'enabled', TRUE,
      'handler_key', 'ops_sweeper_label_renderer_cron_guard'
    ));
  END IF;

  v_next := jsonb_set(v_current, '{tasks}', v_next_tasks, TRUE);
  IF v_next = v_current THEN
    RETURN;
  END IF;

  SELECT COALESCE(sv.version, 0)
  INTO v_prev_version
  FROM public.settings_versions sv
  WHERE sv.id = v_settings.settings_version_id
  LIMIT 1;

  v_new_version := GREATEST(v_prev_version, 0) + 1;
  v_new_version_id := gen_random_uuid();

  -- Close the previous "current" version to satisfy the (category,scope_type,scope_hash) uniqueness.
  UPDATE public.settings_versions sv
  SET effective_until = now()
  WHERE sv.id = v_settings.settings_version_id
    AND sv.scope_hash = v_scope_hash
    AND sv.effective_until IS NULL;

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
    v_new_version_id,
    'ops_sweeper_policy',
    'global',
    NULL,
    v_scope_hash,
    v_new_version,
    v_next,
    1,
    'Patch ops_sweeper_policy defaults (expand cron coverage + label renderer guard)',
    now(),
    now()
  );

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
    v_new_version_id,
    v_next,
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END $$;

COMMIT;
