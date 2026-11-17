-- Plan: PLAN-202512-ops-sweeper-policy-fix / Step: S04
-- Migration: Ops sweeper policy defaults backfill (post-seed)
-- Purpose:
--   - Ensure ops_sweeper_policy defaults include required cron jobs + label renderer guard even on fresh environments.
-- Date: 2025-12-28

BEGIN;

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

  -- Close the previous "current" version to satisfy the (category, scope_type, scope_hash) uniqueness.
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
    'Backfill ops_sweeper_policy required cron jobs + label renderer guard',
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
