BEGIN;
SET LOCAL lock_timeout = '30s';

REVOKE EXECUTE ON FUNCTION
  public.run_api_caller_batch(integer),
  public.run_ops_maintenance_worker(),
  public.ensure_audit_triggers(),
  public.run_campaign_enrollment_worker(),
  public.run_campaign_dispatcher_worker(),
  public.run_circuit_breaker_recovery_worker(),
  public.run_cache_cleanup_worker(),
  public.run_domain_events_worker(),
  public.run_webhook_processor_worker(),
  public.run_ops_cron_health_worker(),
  public.run_ops_queue_health_worker(),
  public.run_alert_aggregation_worker()
FROM PUBLIC, anon, authenticated;

-- Inline workflow dispatch uses the caller's execute privilege.
REVOKE EXECUTE ON FUNCTION public.run_outbound_worker() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_outbound_worker() TO authenticated, service_role;

COMMIT;
