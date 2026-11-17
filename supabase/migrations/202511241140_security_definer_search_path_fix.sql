-- Migration: Enforce search_path on SECURITY DEFINER functions
-- Purpose: Ensure all securdef functions execute with trusted schemas only.

BEGIN;

-- Public schema functions
ALTER FUNCTION public.check_async_response(bigint)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.ci_observability_summary()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.complete_label_job(uuid, text, text, integer, jsonb, text)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.count_api_call_log()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.count_clients()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.count_organizations()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.count_webhook_sources()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.domain_event_from_address_update()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.domain_event_from_shipment_action()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enqueue_domain_event(uuid, text, text, uuid, jsonb, uuid)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.enqueue_manual_review(uuid, uuid, text, uuid, text, text, jsonb)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.finalize_domain_event_from_run()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.geocoding_assert_manual_role()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.geocoding_assert_service_role()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.get_job_call_spec(uuid)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.get_recent_outbound_calls(integer)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.record_webhook_ack(
    uuid,
    uuid,
    text,
    integer,
    jsonb,
    jsonb,
    text,
    text,
    jsonb,
    timestamptz,
    text,
    uuid,
    text,
    uuid,
    integer,
    uuid
)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.request_label_generation(uuid, text, uuid, text, uuid, text)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.resolve_domain_event_policy(uuid, text)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.resolve_organization_id_strict(text, uuid)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.resolve_settings(text, text, uuid)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.run_domain_events_worker()
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.upsert_tenant_domain_event_policy(uuid, jsonb)
  SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.upsert_webhook_ingest_policy(text, uuid, jsonb)
  SET search_path = public, extensions, pg_temp;

-- Workflow handler schema
ALTER FUNCTION workflow_handlers.execute_shipment_create_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path = public, workflow_handlers, extensions, pg_temp;
ALTER FUNCTION workflow_handlers.execute_start_workflow_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path = public, workflow_handlers, extensions, pg_temp;
ALTER FUNCTION workflow_handlers.execute_wait_for_workflow_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  SET search_path = public, workflow_handlers, extensions, pg_temp;

COMMIT;
