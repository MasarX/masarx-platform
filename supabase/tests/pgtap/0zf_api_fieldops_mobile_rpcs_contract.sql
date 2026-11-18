-- Test Suite: api FieldOps mobile policy + ingest RPC contract wrappers
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(63);

WITH names AS (
  SELECT unnest(ARRAY[
    'resolve_mobile_shell_policy',
    'resolve_mobile_diagnostics_policy',
    'resolve_mobile_visibility_policy',
    'resolve_map_policy',
    'resolve_device_policy',
    'resolve_navigation_policy',
    'resolve_driver_safety_policy',
    'resolve_ux_safety_policy',
    'resolve_communication_policy',
    'resolve_address_policy',
    'resolve_mobile_push_policy',
    'resolve_mobile_attestation_policy',
    'resolve_scan_policy',
    'resolve_location_tracking_policy',
    'register_user_device_v1',
    'issue_mobile_attestation_challenge_v1',
    'record_scan_event_v1',
    'record_scan_events_batch_v1',
    'record_location_ping_v1',
    'ui_confirm_route_run_departure_v1'
  ]::text[]) AS name
)
SELECT has_function('api', name, ARRAY['jsonb'], format('api.%s wrapper exists', name))
FROM names;

WITH names AS (
  SELECT unnest(ARRAY[
    'resolve_mobile_shell_policy',
    'resolve_mobile_diagnostics_policy',
    'resolve_mobile_visibility_policy',
    'resolve_map_policy',
    'resolve_device_policy',
    'resolve_navigation_policy',
    'resolve_driver_safety_policy',
    'resolve_ux_safety_policy',
    'resolve_communication_policy',
    'resolve_address_policy',
    'resolve_mobile_push_policy',
    'resolve_mobile_attestation_policy',
    'resolve_scan_policy',
    'resolve_location_tracking_policy',
    'register_user_device_v1',
    'issue_mobile_attestation_challenge_v1',
    'record_scan_event_v1',
    'record_scan_events_batch_v1',
    'record_location_ping_v1',
    'ui_confirm_route_run_departure_v1'
  ]::text[]) AS name
)
SELECT ok(
  has_function_privilege('authenticated', format('api.%s(jsonb)', name), 'EXECUTE'),
  format('authenticated can execute api.%s', name)
)
FROM names;

WITH names AS (
  SELECT unnest(ARRAY[
    'resolve_mobile_shell_policy',
    'resolve_mobile_diagnostics_policy',
    'resolve_mobile_visibility_policy',
    'resolve_map_policy',
    'resolve_device_policy',
    'resolve_navigation_policy',
    'resolve_driver_safety_policy',
    'resolve_ux_safety_policy',
    'resolve_communication_policy',
    'resolve_address_policy',
    'resolve_mobile_push_policy',
    'resolve_mobile_attestation_policy',
    'resolve_scan_policy',
    'resolve_location_tracking_policy',
    'register_user_device_v1',
    'issue_mobile_attestation_challenge_v1',
    'record_scan_event_v1',
    'record_scan_events_batch_v1',
    'record_location_ping_v1',
    'ui_confirm_route_run_departure_v1'
  ]::text[]) AS name
)
SELECT ok(
  NOT has_function_privilege('anon', format('api.%s(jsonb)', name), 'EXECUTE'),
  format('anon cannot execute api.%s', name)
)
FROM names;

SELECT has_function(
  'api',
  'transition_task_v1',
  ARRAY['uuid', 'text', 'text', 'jsonb', 'text'],
  'api.transition_task_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.transition_task_v1(uuid, text, text, jsonb, text)',
    'EXECUTE'
  ),
  'authenticated can execute api.transition_task_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.transition_task_v1(uuid, text, text, jsonb, text)',
    'EXECUTE'
  ),
  'anon cannot execute api.transition_task_v1'
);

SELECT * FROM finish();
ROLLBACK;
