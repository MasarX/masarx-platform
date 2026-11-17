-- Migration: Pin search_path for worker functions to ensure stable resolution

BEGIN;

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

