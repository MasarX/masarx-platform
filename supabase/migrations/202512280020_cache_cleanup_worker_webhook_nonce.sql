-- Plan: PLAN-202512-unified-jobs-maintenance / Step: S04
-- Migration: Cache cleanup worker - webhook nonce dedupe cleanup
-- Purpose: Extend run_cache_cleanup_worker to also prune expired webhook replay-protection nonce rows.
-- Date: 2025-12-28

BEGIN;

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

    -- webhook_nonce_dedupe: best-effort expiry cleanup (replay protection cache).
    IF to_regprocedure('public.cleanup_expired_webhook_nonce_dedupe(integer)') IS NOT NULL THEN
      v_row_count := public.cleanup_expired_webhook_nonce_dedupe(GREATEST(COALESCE(v_throttle.batch_size, 500), 1));
      v_deleted_count := v_deleted_count + COALESCE(v_row_count, 0);
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
