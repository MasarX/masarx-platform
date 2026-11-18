BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(85);

CREATE TEMP TABLE console_v2_api_wrapper_gap_names (
  name TEXT PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO console_v2_api_wrapper_gap_names(name)
VALUES
  ('revoke_user_role_v1'),
  ('force_password_reset_v1'),
  ('suspend_driver_v1'),
  ('restore_driver_v1'),
  ('verify_driver_document_v1'),
  ('reject_driver_document_v1'),
  ('create_driver_compliance_event_v1'),
  ('record_hours_of_service_segment_v1'),
  ('import_job_create_v1'),
  ('import_job_cancel_v1'),
  ('create_alert_rule_v1'),
  ('update_alert_rule_v1'),
  ('pause_alert_rule_v1'),
  ('resume_alert_rule_v1'),
  ('test_alert_rule_v1'),
  ('acknowledge_ops_alert_v1'),
  ('resolve_ops_alert_v1');

SELECT ok(
  to_regprocedure(format('api.%I(jsonb)', name)) IS NOT NULL,
  format('api.%s(jsonb) wrapper exists', name)
)
FROM console_v2_api_wrapper_gap_names;

SELECT ok(
  COALESCE(has_function_privilege(
    'authenticated',
    to_regprocedure(format('api.%I(jsonb)', name))::oid,
    'EXECUTE'
  ), FALSE),
  format('authenticated can execute api.%s(jsonb)', name)
)
FROM console_v2_api_wrapper_gap_names;

SELECT ok(
  COALESCE(has_function_privilege(
    'service_role',
    to_regprocedure(format('api.%I(jsonb)', name))::oid,
    'EXECUTE'
  ), FALSE),
  format('service_role can execute api.%s(jsonb)', name)
)
FROM console_v2_api_wrapper_gap_names;

SELECT ok(
  NOT COALESCE(has_function_privilege(
    'anon',
    to_regprocedure(format('api.%I(jsonb)', name))::oid,
    'EXECUTE'
  ), FALSE),
  format('anon cannot execute api.%s(jsonb)', name)
)
FROM console_v2_api_wrapper_gap_names;

SELECT ok(
  CASE
    WHEN to_regprocedure(format('api.%I(jsonb)', name)) IS NULL THEN FALSE
    ELSE pg_get_functiondef(to_regprocedure(format('api.%I(jsonb)', name)))
      LIKE format('%%SELECT public.%I(p_args);%%', name)
      OR pg_get_functiondef(to_regprocedure(format('api.%I(jsonb)', name)))
      LIKE format('%%SELECT public.%I($1);%%', name)
  END,
  format('api.%s(jsonb) delegates to public.%s(jsonb)', name, name)
)
FROM console_v2_api_wrapper_gap_names;

SELECT * FROM finish();

ROLLBACK;
