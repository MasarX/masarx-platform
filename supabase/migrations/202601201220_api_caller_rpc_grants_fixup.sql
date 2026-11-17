-- Plan: PLAN-202601-api-schema-boundary / Step: S04
-- Migration: Fix grants for api-caller RPCs (public + api wrappers) so edge_api_caller_role works under the api-only exposure model.
BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_names text[] := ARRAY[
    'claim_pending_edge_jobs',
    'get_job_call_spec',
    'log_api_call_event',
    'mark_outbound_call_failure',
    'mark_outbound_call_in_progress',
    'mark_outbound_call_success'
  ];
  v_name text;
  f record;
  v_identity_args text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_caller_role') THEN
    CREATE ROLE edge_api_caller_role NOLOGIN;
  END IF;

  GRANT USAGE ON SCHEMA api TO edge_api_caller_role;
  GRANT USAGE ON SCHEMA public TO edge_api_caller_role;

  FOREACH v_name IN ARRAY v_names
  LOOP
    FOR f IN
      SELECT
        n.nspname AS schema,
        p.proname,
        pg_get_function_identity_arguments(p.oid) AS identity_args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'api')
        AND p.proname = v_name
    LOOP
      v_identity_args := f.identity_args;

      EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC', f.schema, f.proname, v_identity_args);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM anon', f.schema, f.proname, v_identity_args);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM authenticated', f.schema, f.proname, v_identity_args);

      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role', f.schema, f.proname, v_identity_args);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO edge_api_caller_role', f.schema, f.proname, v_identity_args);
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;

