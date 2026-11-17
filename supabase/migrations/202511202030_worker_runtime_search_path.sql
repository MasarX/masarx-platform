-- Migration: Harden worker runtime functions with explicit search_path
-- Date: 2025-11-20 20:30 UTC

BEGIN;

-- Ensure runtime helpers resolve tables/functions within public schema while
-- allowing temporary objects via pg_temp.

ALTER FUNCTION public.log_decision(
    UUID,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    UUID,
    JSONB,
    TEXT
) SET search_path TO public, pg_temp;

ALTER FUNCTION public.create_request_context(TEXT, TEXT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.complete_request_context(UUID, BOOLEAN, INT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.update_cron_config(TEXT)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.check_throttle(TEXT)
    SET search_path TO public, pg_temp;

-- Worker entry points
ALTER FUNCTION public.run_outbound_worker()
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.run_webhook_processor_worker()
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.run_campaign_enrollment_worker()
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.run_campaign_dispatcher_worker()
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.run_alert_aggregation_worker()
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.run_circuit_breaker_recovery_worker()
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.run_cache_cleanup_worker()
    SET search_path TO public, pg_temp;

COMMIT;
