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
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION api.revoke_user_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.revoke_user_role_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.revoke_user_role_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.revoke_user_role_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.revoke_user_role_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.revoke_user_role_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.force_password_reset_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.force_password_reset_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.force_password_reset_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.force_password_reset_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.force_password_reset_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.force_password_reset_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.suspend_driver_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.suspend_driver_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.suspend_driver_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.suspend_driver_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.suspend_driver_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.suspend_driver_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.restore_driver_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.restore_driver_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.restore_driver_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.restore_driver_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.restore_driver_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.restore_driver_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.verify_driver_document_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.verify_driver_document_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.verify_driver_document_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.verify_driver_document_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.verify_driver_document_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.verify_driver_document_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.reject_driver_document_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.reject_driver_document_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.reject_driver_document_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.reject_driver_document_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.reject_driver_document_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.reject_driver_document_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.create_driver_compliance_event_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.create_driver_compliance_event_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.create_driver_compliance_event_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.create_driver_compliance_event_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.create_driver_compliance_event_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.create_driver_compliance_event_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.record_hours_of_service_segment_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.record_hours_of_service_segment_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.record_hours_of_service_segment_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.record_hours_of_service_segment_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.record_hours_of_service_segment_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.record_hours_of_service_segment_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.import_job_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.import_job_create_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.import_job_create_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.import_job_create_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.import_job_create_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.import_job_create_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.import_job_cancel_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.import_job_cancel_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.import_job_cancel_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.import_job_cancel_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.import_job_cancel_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.import_job_cancel_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.create_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.create_alert_rule_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.create_alert_rule_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.create_alert_rule_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.create_alert_rule_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.create_alert_rule_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.update_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.update_alert_rule_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.update_alert_rule_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.update_alert_rule_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.update_alert_rule_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.update_alert_rule_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.pause_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.pause_alert_rule_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.pause_alert_rule_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.pause_alert_rule_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.pause_alert_rule_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.pause_alert_rule_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.resume_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.resume_alert_rule_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.resume_alert_rule_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resume_alert_rule_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.resume_alert_rule_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.resume_alert_rule_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.test_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.test_alert_rule_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.test_alert_rule_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.test_alert_rule_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.test_alert_rule_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.test_alert_rule_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.acknowledge_ops_alert_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.acknowledge_ops_alert_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.acknowledge_ops_alert_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.acknowledge_ops_alert_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.acknowledge_ops_alert_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.acknowledge_ops_alert_v1(jsonb).';

CREATE OR REPLACE FUNCTION api.resolve_ops_alert_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$ SELECT public.resolve_ops_alert_v1(p_args); $wrapper$;

REVOKE ALL ON FUNCTION api.resolve_ops_alert_v1(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_ops_alert_v1(jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION api.resolve_ops_alert_v1(jsonb)
  IS 'Console V2 api-schema wrapper delegating to canonical public.resolve_ops_alert_v1(jsonb).';

SELECT pg_advisory_unlock(hashtext('202605031500_console_v2_api_wrapper_gap_closure_v1'));

COMMIT;
