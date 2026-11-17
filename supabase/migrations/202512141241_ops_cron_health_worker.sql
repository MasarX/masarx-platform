-- Plan: PLAN-202512-ops-whatsapp-alerting-cron-health / Step: S02
-- Migration: Ops cron health worker (stale job alerts)
-- Purpose: Emit alert_triggers when critical pg_cron jobs stop running (partition maintenance, audit trigger ensure, archiving).
-- Notes:
--   - Fully row-driven: monitored jobs and thresholds are defined in settings category ops_cron_health_policy (scope global).
--   - Notification routing uses the existing alert_dispatch_worker + ops_oncall_alerting (tenant-scoped).
--   - No redaction/masking (deferred by decision).

BEGIN;

-- ---------------------------------------------------------------------------
-- Default policy (global): monitored cron jobs + thresholds
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_version_id UUID;
  v_existing_value JSONB;
  v_value JSONB := jsonb_build_object(
    'enabled', TRUE,
    'repeat_minutes', 60,
    'jobs', jsonb_build_array(
      jsonb_build_object('jobname', 'partition_create_next', 'max_staleness_minutes', 60 * 24 * 8, 'severity', 'critical'),
      jsonb_build_object('jobname', 'partition_apply_index_templates', 'max_staleness_minutes', 60 * 24 * 8, 'severity', 'critical'),
      jsonb_build_object('jobname', 'audit_ensure_triggers', 'max_staleness_minutes', 60 * 24 * 8, 'severity', 'critical'),
      jsonb_build_object('jobname', 'partition_archive_old', 'max_staleness_minutes', 60 * 24 * 45, 'severity', 'error')
    )
  );
BEGIN
  -- Do not override an existing configured policy; only seed when missing.
  IF EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ops_cron_health_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

  SELECT sv.id
    INTO v_version_id
    FROM public.settings_versions sv
   WHERE sv.category = 'ops_cron_health_policy'
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
      'ops_cron_health_policy',
      'global',
      NULL,
      v_scope_hash,
      1,
      v_value,
      1,
      'Seed ops_cron_health_policy defaults',
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
    'ops_cron_health_policy',
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
-- Worker: run_ops_cron_health_worker
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_ops_cron_health_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_items_processed INT := 0;
  v_error_occurred BOOLEAN := FALSE;

  v_policy JSONB;
  v_enabled BOOLEAN := FALSE;
  v_repeat_minutes INT := 60;

  v_job JSONB;
  v_jobname TEXT;
  v_max_stale_minutes INT;
  v_severity TEXT;
  v_now TIMESTAMPTZ := now();

  v_cron RECORD;
  v_last_success TIMESTAMPTZ;
  v_is_stale BOOLEAN;

  v_org RECORD;
  v_rule_id UUID;
  v_rule_name TEXT;
  v_sev_lookup_id UUID;
  v_message TEXT;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('ops_cron_health_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('ops_cron_health_worker');

  v_policy := public.resolve_settings('ops_cron_health_policy', 'global', NULL);
  v_enabled := FALSE;
  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION WHEN OTHERS THEN
    v_enabled := FALSE;
  END;

  IF NOT v_enabled THEN
    PERFORM public.complete_request_context(v_context, FALSE, 0);
    PERFORM public.update_cron_config('ops_cron_health_worker');
    RETURN json_build_object('status', 'disabled');
  END IF;

  BEGIN
    v_repeat_minutes := GREATEST(COALESCE(NULLIF(v_policy->>'repeat_minutes', '')::INT, 60), 1);
  EXCEPTION WHEN OTHERS THEN
    v_repeat_minutes := 60;
  END;

  IF v_policy IS NULL OR jsonb_typeof(v_policy->'jobs') <> 'array' THEN
    PERFORM public.complete_request_context(v_context, FALSE, 0);
    PERFORM public.update_cron_config('ops_cron_health_worker');
    RETURN json_build_object('status', 'no_jobs_configured');
  END IF;

  -- Only notify tenants that explicitly enabled ops_oncall_alerting (tenant scope).
  FOR v_org IN
    SELECT s.scope_id AS organization_id
    FROM public.settings s
    WHERE s.category = 'ops_oncall_alerting'
      AND s.scope_type = 'tenant'
      AND s.scope_id IS NOT NULL
      AND COALESCE((s.cached_value->>'enabled')::BOOLEAN, FALSE) = TRUE
  LOOP
    v_rule_name := format('ops::%s::cron_health_guard', v_org.organization_id::text);

    SELECT id INTO v_rule_id
    FROM public.alert_rules
    WHERE rule_name = v_rule_name
    LIMIT 1;

    IF v_rule_id IS NULL THEN
      SELECT lv.id
      INTO v_sev_lookup_id
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'severity_level'
        AND lv.value = 'critical'
      LIMIT 1;

      INSERT INTO public.alert_rules (
        organization_id,
        rule_name,
        enabled,
        priority,
        trigger_source,
        trigger_conditions,
        throttle_window_minutes,
        throttle_key_fields,
        alert_severity_lookup_id,
        alert_channels
      )
      VALUES (
        v_org.organization_id,
        v_rule_name,
        TRUE,
        1000,
        'system_cron',
        jsonb_build_object('reason', 'cron_health'),
        v_repeat_minutes,
        jsonb_build_array('jobname'),
        v_sev_lookup_id,
        jsonb_build_array('whatsapp')
      )
      RETURNING id INTO v_rule_id;
    END IF;

    -- Evaluate each monitored cron job against cron.job_run_details.
    FOR v_job IN
      SELECT value FROM jsonb_array_elements(v_policy->'jobs')
    LOOP
      v_jobname := NULLIF(v_job->>'jobname', '');
      IF v_jobname IS NULL THEN
        CONTINUE;
      END IF;

      BEGIN
        v_max_stale_minutes := GREATEST(COALESCE(NULLIF(v_job->>'max_staleness_minutes', '')::INT, 60), 1);
      EXCEPTION WHEN OTHERS THEN
        v_max_stale_minutes := 60;
      END;

      v_severity := LOWER(COALESCE(NULLIF(v_job->>'severity', ''), 'critical'));

      SELECT j.jobid, j.schedule, j.active
      INTO v_cron
      FROM cron.job j
      WHERE j.jobname = v_jobname
      LIMIT 1;

      v_last_success := NULL;
      IF FOUND AND v_cron.jobid IS NOT NULL THEN
        SELECT max(d.end_time)
        INTO v_last_success
        FROM cron.job_run_details d
        WHERE d.jobid = v_cron.jobid
          AND d.status = 'succeeded';
      END IF;

      v_is_stale := (v_last_success IS NULL) OR (v_last_success < v_now - make_interval(mins => v_max_stale_minutes));

      IF NOT v_is_stale THEN
        CONTINUE;
      END IF;

      -- Dedupe: do not emit more often than repeat_minutes.
      IF EXISTS (
        SELECT 1
        FROM public.alert_triggers at
        WHERE at.organization_id = v_org.organization_id
          AND at.resource_type = 'cron_job'
          AND COALESCE(at.context->>'jobname', '') = v_jobname
          AND at."timestamp" > v_now - make_interval(mins => v_repeat_minutes)
        LIMIT 1
      ) THEN
        CONTINUE;
      END IF;

      v_message := format(
        'Cron job health: job=%s stale (last_success=%s, max_staleness_minutes=%s, active=%s, schedule=%s)',
        v_jobname,
        COALESCE(to_char(v_last_success, 'YYYY-MM-DD HH24:MI:SSOF'), 'never'),
        v_max_stale_minutes,
        COALESCE(v_cron.active::text, 'false'),
        COALESCE(v_cron.schedule, 'unknown')
      );

      -- Correlate to this worker run (used by alert_dispatch_worker message formatting).
      PERFORM set_config('request.correlation_id', v_context::text, true);

      INSERT INTO public.alert_triggers (
        alert_rule_id,
        organization_id,
        resource_type,
        resource_id,
        severity,
        message,
        context
      )
      VALUES (
        v_rule_id,
        v_org.organization_id,
        'cron_job',
        gen_random_uuid(),
        v_severity,
        v_message,
        jsonb_strip_nulls(jsonb_build_object(
          'jobname', v_jobname,
          'jobid', v_cron.jobid,
          'schedule', v_cron.schedule,
          'active', v_cron.active,
          'last_success_end_time', v_last_success,
          'max_staleness_minutes', v_max_stale_minutes,
          'correlation_id', v_context
        ))
      );

      v_items_processed := v_items_processed + 1;
    END LOOP;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error_occurred, v_items_processed);
  PERFORM public.update_cron_config('ops_cron_health_worker');

  RETURN json_build_object(
    'status', 'completed',
    'items_processed', v_items_processed,
    'error_occurred', v_error_occurred
  );
EXCEPTION WHEN OTHERS THEN
  v_error_occurred := TRUE;
  PERFORM public.complete_request_context(v_context, TRUE, v_items_processed);
  PERFORM public.update_cron_config('ops_cron_health_worker');
  RETURN json_build_object('status', 'failed', 'error', SQLERRM);
END;
$$;

ALTER FUNCTION public.run_ops_cron_health_worker()
  SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- Worker registry + cron_config baseline
-- ---------------------------------------------------------------------------
INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'ops_cron_health_worker',
  'monitoring',
  'Monitor pg_cron job health and emit alert_triggers when critical jobs are stale.',
  '*/5 * * * *',
  jsonb_build_object('policy_category', 'ops_cron_health_policy', 'oncall_category', 'ops_oncall_alerting'),
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
  'ops_cron_health_worker',
  300,
  100,
  TRUE,
  'Cron health monitoring (settings: ops_cron_health_policy; notify tenants with ops_oncall_alerting enabled)'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = TRUE,
  notes = EXCLUDED.notes;

-- Schedule via pg_cron (idempotent).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ops_cron_health_tick') THEN
    PERFORM cron.unschedule('ops_cron_health_tick');
  END IF;
END $$;

SELECT cron.schedule(
  'ops_cron_health_tick',
  '*/5 * * * *',
  $$SELECT public.run_ops_cron_health_worker();$$
);

COMMIT;
