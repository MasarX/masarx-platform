-- Migration: Geocoding search_path hardening
-- Purpose: Pin SECURITY DEFINER / handler functions to safe search_path for pgTAP 045.
-- Alignment: SIMPLE · SCALABLE · DYNAMIC · zero hardcoding; safety for secdef.

BEGIN;

-- Pin workflow handler helpers and handlers
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT unnest(ARRAY[
      'workflow_handlers.geocoding_resolve_policy_for_run(workflow_runs)'::regprocedure,
      'workflow_handlers.geocoding_get_plugin(jsonb, text)'::regprocedure,
      'workflow_handlers.geocoding_should_log_tokens(jsonb)'::regprocedure,
      'workflow_handlers.geocoding_log_match(uuid, uuid, jsonb, jsonb)'::regprocedure,
      'workflow_handlers.execute_geocode_cache_v1(workflow_run_steps, workflow_runs, jsonb)'::regprocedure,
      'workflow_handlers.execute_geo_coordinate_v1(workflow_run_steps, workflow_runs, jsonb)'::regprocedure,
      'workflow_handlers.execute_geo_local_lookup_v1(workflow_run_steps, workflow_runs, jsonb)'::regprocedure,
      'workflow_handlers.execute_geo_decision_v1(workflow_run_steps, workflow_runs, jsonb)'::regprocedure,
      'workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps, workflow_runs, jsonb)'
    ])
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path TO workflow_handlers, public, extensions, pg_temp',
      fn
    );
  END LOOP;
END;
$$;

-- Pin SECURITY DEFINER auto-learn function
ALTER FUNCTION public.auto_learn_geography(UUID, UUID, UUID, UUID, JSONB, JSONB, NUMERIC, TEXT)
  SET search_path TO public, extensions, workflow_handlers, pg_temp;

COMMIT;
