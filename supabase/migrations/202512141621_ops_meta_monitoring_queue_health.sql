-- Plan: PLAN-202512-logging-prod-ready-ssot-alert-delivery-v1 / Step: S03
-- Migration: Meta-monitoring (cron policy patch + ops queue/worker health)
-- Purpose:
--   - Extend ops_cron_health_policy defaults to monitor core alert/outbound cron ticks.
--   - Add ops_queue_health_worker to emit alert_triggers when:
--       * alert dispatch backlog exists (notified_at still NULL)
--       * outbound_calls pending backlog exists
--       * critical workers stop updating cron_config.last_run_at

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Patch: ops_cron_health_policy defaults (append missing job entries only)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings RECORD;
  v_current JSONB;
  v_jobs JSONB;
  v_required JSONB := jsonb_build_array(
    jsonb_build_object('jobname', 'alert_dispatch_tick', 'max_staleness_minutes', 60, 'severity', 'critical'),
    jsonb_build_object('jobname', 'outbound_worker_tick', 'max_staleness_minutes', 60, 'severity', 'critical'),
    jsonb_build_object('jobname', 'api_caller_batch_tick', 'max_staleness_minutes', 60, 'severity', 'critical')
  );
  v_job JSONB;
  v_jobname TEXT;
  v_next_jobs JSONB;
  v_next JSONB;
  v_prev_version INT := 0;
  v_new_version INT := 1;
  v_new_version_id UUID;
BEGIN
  SELECT s.settings_version_id, s.cached_value
  INTO v_settings
  FROM public.settings s
  WHERE s.category = 'ops_cron_health_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  ORDER BY s.last_updated DESC
  LIMIT 1;

  IF v_settings.settings_version_id IS NULL THEN
    -- No policy yet (seed migration will handle).
    RETURN;
  END IF;

  v_current := COALESCE(v_settings.cached_value, '{}'::jsonb);
  v_jobs := CASE WHEN jsonb_typeof(v_current->'jobs') = 'array' THEN v_current->'jobs' ELSE '[]'::jsonb END;
  v_next_jobs := v_jobs;

  FOR v_job IN SELECT value FROM jsonb_array_elements(v_required) LOOP
    v_jobname := NULLIF(v_job->>'jobname', '');
    IF v_jobname IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_jobs) e
      WHERE COALESCE(e->>'jobname', '') = v_jobname
    ) THEN
      v_next_jobs := v_next_jobs || jsonb_build_array(v_job);
    END IF;
  END LOOP;

  v_next := jsonb_set(v_current, '{jobs}', v_next_jobs, TRUE);
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
    'ops_cron_health_policy',
    'global',
    NULL,
    v_scope_hash,
    v_new_version,
    v_next,
    1,
    'Patch ops_cron_health_policy defaults (monitor alert/outbound cron ticks)',
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
    'ops_cron_health_policy',
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

-- ---------------------------------------------------------------------------
-- Seed: ops_queue_health_policy (global)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_version_id UUID;
  v_value JSONB := jsonb_build_object(
    'enabled', TRUE,
    'repeat_minutes', 60,
    'alert_dispatch_backlog', jsonb_build_object('max_age_minutes', 5, 'severity', 'critical'),
    'outbound_calls_backlog', jsonb_build_object('max_age_minutes', 10, 'severity', 'critical'),
    'worker_health', jsonb_build_object(
      'max_staleness_minutes', 10,
      'severity', 'critical',
      'workers', jsonb_build_array('alert_dispatch_worker', 'ops_cron_health_worker', 'outbound_worker', 'alert_aggregation_worker')
    )
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ops_queue_health_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

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
    'ops_queue_health_policy',
    'global',
    NULL,
    v_scope_hash,
    1,
    v_value,
    1,
    'Seed ops_queue_health_policy defaults',
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
    'ops_queue_health_policy',
    'global',
    NULL,
    v_scope_hash,
    v_version_id,
    v_value,
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END $$;

-- ---------------------------------------------------------------------------
-- Worker: run_ops_queue_health_worker
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_ops_queue_health_worker()
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

  v_alert_cfg JSONB;
  v_alert_max_age INT := 5;
  v_alert_severity TEXT := 'critical';

  v_outbound_cfg JSONB;
  v_outbound_max_age INT := 10;
  v_outbound_severity TEXT := 'critical';

  v_worker_cfg JSONB;
  v_worker_max_stale INT := 10;
  v_worker_severity TEXT := 'critical';
  v_workers JSONB;
  v_worker_name TEXT;

  v_now TIMESTAMPTZ := now();

  v_org RECORD;
  v_oncall JSONB;
  v_channels JSONB := '[]'::jsonb;
  v_rule_id UUID;
  v_rule_name TEXT;
  v_sev_lookup_id UUID;

  v_count INT;
  v_oldest TIMESTAMPTZ;
  v_message TEXT;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('ops_queue_health_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('ops_queue_health_worker');

  v_policy := public.resolve_settings('ops_queue_health_policy', 'global', NULL);
  v_enabled := FALSE;
  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION WHEN OTHERS THEN
    v_enabled := FALSE;
  END;

  IF NOT v_enabled THEN
    PERFORM public.complete_request_context(v_context, FALSE, 0);
    PERFORM public.update_cron_config('ops_queue_health_worker');
    RETURN json_build_object('status', 'disabled');
  END IF;

  BEGIN
    v_repeat_minutes := GREATEST(COALESCE(NULLIF(v_policy->>'repeat_minutes', '')::INT, 60), 1);
  EXCEPTION WHEN OTHERS THEN
    v_repeat_minutes := 60;
  END;

  v_alert_cfg := COALESCE(v_policy->'alert_dispatch_backlog', '{}'::jsonb);
  BEGIN
    v_alert_max_age := GREATEST(COALESCE(NULLIF(v_alert_cfg->>'max_age_minutes', '')::INT, 5), 1);
  EXCEPTION WHEN OTHERS THEN
    v_alert_max_age := 5;
  END;
  v_alert_severity := LOWER(COALESCE(NULLIF(v_alert_cfg->>'severity', ''), 'critical'));

  v_outbound_cfg := COALESCE(v_policy->'outbound_calls_backlog', '{}'::jsonb);
  BEGIN
    v_outbound_max_age := GREATEST(COALESCE(NULLIF(v_outbound_cfg->>'max_age_minutes', '')::INT, 10), 1);
  EXCEPTION WHEN OTHERS THEN
    v_outbound_max_age := 10;
  END;
  v_outbound_severity := LOWER(COALESCE(NULLIF(v_outbound_cfg->>'severity', ''), 'critical'));

  v_worker_cfg := COALESCE(v_policy->'worker_health', '{}'::jsonb);
  BEGIN
    v_worker_max_stale := GREATEST(COALESCE(NULLIF(v_worker_cfg->>'max_staleness_minutes', '')::INT, 10), 1);
  EXCEPTION WHEN OTHERS THEN
    v_worker_max_stale := 10;
  END;
  v_worker_severity := LOWER(COALESCE(NULLIF(v_worker_cfg->>'severity', ''), 'critical'));
  v_workers := COALESCE(v_worker_cfg->'workers', '[]'::jsonb);

  -- Only notify tenants that explicitly enabled ops_oncall_alerting (tenant scope).
  FOR v_org IN
    SELECT s.scope_id AS organization_id
    FROM public.settings s
    WHERE s.category = 'ops_oncall_alerting'
      AND s.scope_type = 'tenant'
      AND s.scope_id IS NOT NULL
      AND COALESCE((s.cached_value->>'enabled')::BOOLEAN, FALSE) = TRUE
  LOOP
    v_oncall := public.resolve_settings('ops_oncall_alerting', 'tenant', v_org.organization_id);

    -- Derive alert_channels from on-call config (preferred), else fall back to whatsapp for compatibility.
    v_channels := '[]'::jsonb;
    IF jsonb_typeof(v_oncall->'channels') = 'object' THEN
      SELECT COALESCE(jsonb_agg(key), '[]'::jsonb)
      INTO v_channels
      FROM jsonb_each(v_oncall->'channels')
      WHERE COALESCE((value->>'enabled')::BOOLEAN, TRUE) = TRUE;
    ELSIF jsonb_typeof(v_oncall->'whatsapp') = 'object' THEN
      v_channels := jsonb_build_array('whatsapp');
    END IF;
    IF jsonb_typeof(v_channels) <> 'array' OR jsonb_array_length(v_channels) = 0 THEN
      v_channels := jsonb_build_array('whatsapp');
    END IF;

    v_rule_name := format('ops::%s::queue_health_guard', v_org.organization_id::text);

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
        900,
        'system_queue',
        jsonb_build_object('reason', 'queue_health'),
        v_repeat_minutes,
        jsonb_build_array('check_key'),
        v_sev_lookup_id,
        v_channels
      )
      RETURNING id INTO v_rule_id;
    ELSE
      -- Keep channels aligned with on-call config.
      UPDATE public.alert_rules
      SET alert_channels = v_channels,
          updated_at = now()
      WHERE id = v_rule_id;
    END IF;

    -- Correlate to this worker run for downstream tracing.
    PERFORM set_config('request.correlation_id', v_context::text, true);

    -- 1) Alert dispatch backlog (notified_at still NULL)
    SELECT COUNT(*), MIN(at."timestamp")
    INTO v_count, v_oldest
    FROM public.alert_triggers at
    WHERE at.organization_id = v_org.organization_id
      AND at.notified_at IS NULL
      AND at."timestamp" < v_now - make_interval(mins => v_alert_max_age);

    IF COALESCE(v_count, 0) > 0 THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.alert_triggers at2
        WHERE at2.organization_id = v_org.organization_id
          AND at2.resource_type = 'ops_queue_health'
          AND COALESCE(at2.context->>'check_key', '') = 'alert_dispatch_backlog'
          AND at2."timestamp" > v_now - make_interval(mins => v_repeat_minutes)
        LIMIT 1
      ) THEN
        v_message := format(
          'Queue health: alert_triggers backlog (count=%s, oldest=%s, max_age_minutes=%s)',
          v_count,
          COALESCE(to_char(v_oldest, 'YYYY-MM-DD HH24:MI:SSOF'), 'unknown'),
          v_alert_max_age
        );

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
          'ops_queue_health',
          gen_random_uuid(),
          v_alert_severity,
          v_message,
          jsonb_strip_nulls(jsonb_build_object(
            'check_key', 'alert_dispatch_backlog',
            'count', v_count,
            'oldest_timestamp', v_oldest,
            'max_age_minutes', v_alert_max_age,
            'correlation_id', v_context
          ))
        );

        v_items_processed := v_items_processed + 1;
      END IF;
    END IF;

    -- 2) Outbound calls backlog (pending too long)
    SELECT COUNT(*), MIN(oc.scheduled_at)
    INTO v_count, v_oldest
    FROM public.outbound_calls oc
    JOIN public.providers p ON p.id = oc.target_id
    WHERE oc.status = 'pending'
      AND oc.scheduled_at < v_now - make_interval(mins => v_outbound_max_age)
      AND oc.target_type = 'provider'
      AND p.organization_id = v_org.organization_id;

    IF COALESCE(v_count, 0) > 0 THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.alert_triggers at2
        WHERE at2.organization_id = v_org.organization_id
          AND at2.resource_type = 'ops_queue_health'
          AND COALESCE(at2.context->>'check_key', '') = 'outbound_calls_backlog'
          AND at2."timestamp" > v_now - make_interval(mins => v_repeat_minutes)
        LIMIT 1
      ) THEN
        v_message := format(
          'Queue health: outbound_calls pending backlog (count=%s, oldest_scheduled_at=%s, max_age_minutes=%s)',
          v_count,
          COALESCE(to_char(v_oldest, 'YYYY-MM-DD HH24:MI:SSOF'), 'unknown'),
          v_outbound_max_age
        );

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
          'ops_queue_health',
          gen_random_uuid(),
          v_outbound_severity,
          v_message,
          jsonb_strip_nulls(jsonb_build_object(
            'check_key', 'outbound_calls_backlog',
            'count', v_count,
            'oldest_scheduled_at', v_oldest,
            'max_age_minutes', v_outbound_max_age,
            'correlation_id', v_context
          ))
        );

        v_items_processed := v_items_processed + 1;
      END IF;
    END IF;

    -- 3) Worker staleness via cron_config.last_run_at
    IF jsonb_typeof(v_workers) = 'array' THEN
      FOR v_worker_name IN
        SELECT value FROM jsonb_array_elements_text(v_workers) a(value)
      LOOP
        IF v_worker_name IS NULL OR btrim(v_worker_name) = '' THEN
          CONTINUE;
        END IF;

        SELECT COUNT(*)
        INTO v_count
        FROM public.cron_config cc
        WHERE cc.worker_name = v_worker_name
          AND (
            cc.last_run_at IS NULL
            OR cc.last_run_at < v_now - make_interval(mins => v_worker_max_stale)
          );

        IF COALESCE(v_count, 0) = 0 THEN
          CONTINUE;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM public.alert_triggers at2
          WHERE at2.organization_id = v_org.organization_id
            AND at2.resource_type = 'ops_queue_health'
            AND COALESCE(at2.context->>'check_key', '') = 'worker_stale'
            AND COALESCE(at2.context->>'worker_name', '') = v_worker_name
            AND at2."timestamp" > v_now - make_interval(mins => v_repeat_minutes)
          LIMIT 1
        ) THEN
          CONTINUE;
        END IF;

        v_message := format(
          'Worker health: %s stale (last_run_at missing or older than %s minutes)',
          v_worker_name,
          v_worker_max_stale
        );

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
          'ops_queue_health',
          gen_random_uuid(),
          v_worker_severity,
          v_message,
          jsonb_strip_nulls(jsonb_build_object(
            'check_key', 'worker_stale',
            'worker_name', v_worker_name,
            'max_staleness_minutes', v_worker_max_stale,
            'correlation_id', v_context
          ))
        );

        v_items_processed := v_items_processed + 1;
      END LOOP;
    END IF;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error_occurred, v_items_processed);
  PERFORM public.update_cron_config('ops_queue_health_worker');

  RETURN json_build_object(
    'status', 'completed',
    'items_processed', v_items_processed,
    'error_occurred', v_error_occurred
  );
EXCEPTION WHEN OTHERS THEN
  v_error_occurred := TRUE;
  PERFORM public.complete_request_context(v_context, TRUE, v_items_processed);
  PERFORM public.update_cron_config('ops_queue_health_worker');
  RETURN json_build_object('status', 'failed', 'error', SQLERRM);
END;
$$;

ALTER FUNCTION public.run_ops_queue_health_worker()
  SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- Worker registry + cron_config baseline
-- ---------------------------------------------------------------------------
INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'ops_queue_health_worker',
  'monitoring',
  'Detect stale/missing ops maintenance signals (alert backlog, outbound backlog, worker staleness) and emit alert_triggers.',
  '*/5 * * * *',
  jsonb_build_object('policy_category', 'ops_queue_health_policy', 'oncall_category', 'ops_oncall_alerting'),
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
  'ops_queue_health_worker',
  300,
  50,
  TRUE,
  'Ops meta-monitoring (settings: ops_queue_health_policy; notifies tenants with ops_oncall_alerting enabled)'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = TRUE,
  notes = EXCLUDED.notes;

-- Schedule via pg_cron (idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ops_queue_health_tick') THEN
    PERFORM cron.unschedule('ops_queue_health_tick');
  END IF;
END $$;

SELECT cron.schedule(
  'ops_queue_health_tick',
  '*/5 * * * *',
  $$SELECT public.run_ops_queue_health_worker();$$
);

COMMIT;
