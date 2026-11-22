BEGIN;
SET LOCAL lock_timeout = '30s';

REVOKE EXECUTE ON FUNCTION public.worker_action_geocode_enrich(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_action_geocode_enrich(uuid, jsonb, jsonb)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_recent_outbound_calls(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_recent_outbound_calls(integer)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.public_tracking_enqueue_recipient_notification_v1(uuid, uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_tracking_enqueue_recipient_notification_v1(uuid, uuid, uuid, text, text, jsonb)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.public_tracking_queue_provider_update_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_tracking_queue_provider_update_v1(jsonb)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_pending_jobs(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_jobs(integer)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.requeue_expired_edge_jobs(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_expired_edge_jobs(integer)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.ops_maintenance_quarantine_outbound_calls(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_maintenance_quarantine_outbound_calls(jsonb)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_outbound_call_failover_v1(uuid, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_outbound_call_failover_v1(uuid, jsonb, text, uuid)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_outbound_call_provider_failure_v1(uuid, integer, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_outbound_call_provider_failure_v1(uuid, integer, text, text, uuid)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.finalize_outbound_workflow_step_v1(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_outbound_workflow_step_v1(uuid, text)
  TO service_role;

COMMIT;
