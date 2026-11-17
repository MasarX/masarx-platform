-- Migration: Harden view grants for internal observability and security views
-- Purpose: Ensure that internal views in the public schema are not exposed
-- via anon/authenticated roles. Access is restricted to service_role and
-- the owner (postgres), while row-level security remains enforced on the
-- underlying tables.

BEGIN;

-- Internal observability / metrics / security views. Revoke broad access and
-- grant read access only to service_role (plus the owner).
DO $$
BEGIN
  PERFORM 1;
  -- ci_observability_summary_v
  EXECUTE 'REVOKE ALL ON public.ci_observability_summary_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.ci_observability_summary_v TO service_role';

  -- edge_job_health
  EXECUTE 'REVOKE ALL ON public.edge_job_health FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.edge_job_health TO service_role';

  -- geocoding_cache_metrics_v
  EXECUTE 'REVOKE ALL ON public.geocoding_cache_metrics_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.geocoding_cache_metrics_v TO service_role';

  -- geocoding_provider_spend_v
  EXECUTE 'REVOKE ALL ON public.geocoding_provider_spend_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.geocoding_provider_spend_v TO service_role';

  -- geocoding_queue_status_v
  EXECUTE 'REVOKE ALL ON public.geocoding_queue_status_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.geocoding_queue_status_v TO service_role';

  -- non_engine_outbound_calls_v
  EXECUTE 'REVOKE ALL ON public.non_engine_outbound_calls_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.non_engine_outbound_calls_v TO service_role';

  -- observability_events_v
  EXECUTE 'REVOKE ALL ON public.observability_events_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.observability_events_v TO service_role';

  -- partition_inventory
  EXECUTE 'REVOKE ALL ON public.partition_inventory FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.partition_inventory TO service_role';

  -- pg_policies (introspection helper)
  EXECUTE 'REVOKE ALL ON public.pg_policies FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.pg_policies TO service_role';

  -- security_rls_user_facing (RLS coverage helper)
  EXECUTE 'REVOKE ALL ON public.security_rls_user_facing FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.security_rls_user_facing TO service_role';

  -- shipment_label_payload_v
  EXECUTE 'REVOKE ALL ON public.shipment_label_payload_v FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.shipment_label_payload_v TO service_role';

  -- webhook_ack_history
  EXECUTE 'REVOKE ALL ON public.webhook_ack_history FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.webhook_ack_history TO service_role';

  -- webhook_response_events
  EXECUTE 'REVOKE ALL ON public.webhook_response_events FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.webhook_response_events TO service_role';

  -- webhook_response_latest
  EXECUTE 'REVOKE ALL ON public.webhook_response_latest FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.webhook_response_latest TO service_role';

  -- PostGIS metadata views: restrict to internal roles only as well.
  EXECUTE 'REVOKE ALL ON public.geography_columns FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.geography_columns TO service_role';

  EXECUTE 'REVOKE ALL ON public.geometry_columns FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT ON public.geometry_columns TO service_role';
END;
$$;

COMMIT;
