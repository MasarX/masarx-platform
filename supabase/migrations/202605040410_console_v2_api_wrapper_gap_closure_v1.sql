-- Plan: Console V2 live-action API wrapper gap closure
-- Step: expose api-schema wrappers for existing canonical Console V2 live actions.
--
-- Console V2 browser RPC traffic is pinned to the api schema. The canonical
-- public RPCs below already exist and are capability/RLS-gated there, but the
-- api schema did not expose matching wrappers, causing live PostgREST calls to
-- miss schema-cache functions.
--
-- This migration is intentionally limited to the auditor's named frontend RPCs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031500_console_v2_api_wrapper_gap_closure_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

DO $$
DECLARE
  v_name TEXT;
  v_names TEXT[] := ARRAY[
    'revoke_user_role_v1',
    'force_password_reset_v1',
    'suspend_driver_v1',
    'restore_driver_v1',
    'verify_driver_document_v1',
    'reject_driver_document_v1',
    'create_driver_compliance_event_v1',
    'record_hours_of_service_segment_v1',
    'import_job_create_v1',
    'import_job_cancel_v1',
    'create_alert_rule_v1',
    'update_alert_rule_v1',
    'pause_alert_rule_v1',
    'resume_alert_rule_v1',
    'test_alert_rule_v1',
    'acknowledge_ops_alert_v1',
    'resolve_ops_alert_v1'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_names
  LOOP
    IF to_regprocedure(format('public.%I(jsonb)', v_name)) IS NULL THEN
      RAISE EXCEPTION 'console-v2 api wrapper gap closure: public.%(jsonb) is missing', v_name;
    END IF;

    EXECUTE format(
      $sql$
      CREATE OR REPLACE FUNCTION api.%1$I(p_args jsonb)
      RETURNS jsonb
      LANGUAGE sql
      VOLATILE
      SECURITY DEFINER
      SET search_path TO public, extensions, pg_temp
      AS $function$
        SELECT public.%1$I(p_args);
      $function$;
      $sql$,
      v_name
    );

    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(jsonb) FROM PUBLIC', v_name);
    EXECUTE format('REVOKE ALL ON FUNCTION api.%I(jsonb) FROM anon', v_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION api.%I(jsonb) TO authenticated, service_role', v_name);
    EXECUTE format(
      'COMMENT ON FUNCTION api.%I(jsonb) IS %L',
      v_name,
      format('Console V2 api-schema wrapper delegating to canonical public.%s(jsonb).', v_name)
    );
  END LOOP;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202605031500_console_v2_api_wrapper_gap_closure_v1'));

COMMIT;
