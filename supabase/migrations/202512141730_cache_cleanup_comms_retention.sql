-- Migration: Cache cleanup worker - comms retention
-- Purpose:
--   - Extend run_cache_cleanup_worker to prune low-value comms state tables (sessions/rate limits) using a row-driven retention policy.
--   - Keep values configurable via settings (no hardcoded TTLs in code).
-- Date: 2025-12-14

BEGIN;

-------------------------------------------------------------------------------
-- 1) Schema + global defaults: maintenance_cleanup_policy (v1)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'maintenance_cleanup_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'comms_reply_sessions_retention_days', jsonb_build_object('type', 'integer', 'minimum', 0),
      'comms_reply_rate_limits_retention_days', jsonb_build_object('type', 'integer', 'minimum', 0)
    )
  ),
  'Maintenance cleanup retention policy used by run_cache_cleanup_worker (comms reply state pruning).',
  jsonb_build_array(jsonb_build_object(
    'version', 1,
    'comms_reply_sessions_retention_days', 7,
    'comms_reply_rate_limits_retention_days', 30
  )),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'comms_reply_sessions_retention_days', 7,
    'comms_reply_rate_limits_retention_days', 30
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'maintenance_cleanup_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global maintenance_cleanup_policy (comms cleanup retention)',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'maintenance_cleanup_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'maintenance_cleanup_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO UPDATE SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = EXCLUDED.last_updated;

-------------------------------------------------------------------------------
-- 2) Worker: extend run_cache_cleanup_worker()
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.run_cache_cleanup_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_deleted_count INT := 0;
    v_row_count INT := 0;
    v_cleanup_policy JSONB;
    v_sessions_days INT;
    v_rate_limits_days INT;
    v_now TIMESTAMPTZ := now();
BEGIN
    SELECT * INTO v_throttle FROM public.check_throttle('cache_cleanup_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := public.create_request_context('cache_cleanup_worker');

    v_cleanup_policy := public.resolve_settings('maintenance_cleanup_policy', 'global', NULL);
    IF v_cleanup_policy IS NULL THEN
      RAISE EXCEPTION 'maintenance_cleanup_policy_missing';
    END IF;

    v_sessions_days := NULLIF(v_cleanup_policy->>'comms_reply_sessions_retention_days', '')::INT;
    v_rate_limits_days := NULLIF(v_cleanup_policy->>'comms_reply_rate_limits_retention_days', '')::INT;
    IF v_sessions_days IS NULL OR v_sessions_days < 0 THEN
      RAISE EXCEPTION 'maintenance_cleanup_policy_invalid_comms_reply_sessions_retention_days';
    END IF;
    IF v_rate_limits_days IS NULL OR v_rate_limits_days < 0 THEN
      RAISE EXCEPTION 'maintenance_cleanup_policy_invalid_comms_reply_rate_limits_retention_days';
    END IF;

    -- settings_cache (historical behavior)
    DELETE FROM public.settings_cache
    WHERE expires_at IS NOT NULL
      AND expires_at < v_now;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- comms_reply_sessions: delete expired sessions once past retention window.
    IF to_regclass('public.comms_reply_sessions') IS NOT NULL THEN
      DELETE FROM public.comms_reply_sessions
      WHERE expires_at IS NOT NULL
        AND expires_at < (v_now - make_interval(days => v_sessions_days));
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_deleted_count := v_deleted_count + v_row_count;
    END IF;

    -- comms_reply_rate_limits: delete stale counters once past retention window.
    IF to_regclass('public.comms_reply_rate_limits') IS NOT NULL THEN
      DELETE FROM public.comms_reply_rate_limits
      WHERE updated_at < (v_now - make_interval(days => v_rate_limits_days));
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_deleted_count := v_deleted_count + v_row_count;
    END IF;

    PERFORM public.complete_request_context(v_context, FALSE, COALESCE(v_deleted_count, 0));
    PERFORM public.update_cron_config('cache_cleanup_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', COALESCE(v_deleted_count, 0),
        'error_occurred', FALSE
    );
END;
$$;

COMMIT;
