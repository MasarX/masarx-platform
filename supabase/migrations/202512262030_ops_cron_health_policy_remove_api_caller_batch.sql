-- Plan: PLAN-202512-unified-jobs-maintenance / Step: S04
-- Migration: Ops cron health policy - remove api_caller_batch_tick (stale entry)
-- Purpose: Prevent false-positive cron health alerts for api_caller_batch_tick when edge batch dispatch is not scheduled.
-- Date: 2025-12-26

BEGIN;

DO $$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings RECORD;
  v_current JSONB;
  v_jobs JSONB;
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
    RETURN;
  END IF;

  v_current := COALESCE(v_settings.cached_value, '{}'::jsonb);
  v_jobs := CASE WHEN jsonb_typeof(v_current->'jobs') = 'array' THEN v_current->'jobs' ELSE '[]'::jsonb END;

  SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
  INTO v_next_jobs
  FROM jsonb_array_elements(v_jobs) e
  WHERE COALESCE(e->>'jobname', '') <> 'api_caller_batch_tick';

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
    'Remove api_caller_batch_tick from ops_cron_health_policy (not scheduled)',
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

COMMIT;

