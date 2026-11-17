BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT ok(
  to_regprocedure(
    'workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'
  ) IS NOT NULL,
  'shipment geocode refresh handler exists'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%manual_review_task_id%',
  'handler returns manual review task readback'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%geocoding_attempt_id%',
  'handler returns geocoding attempt readback'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%geocode_id%',
  'handler returns geocode row readback'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%record_shipment_action_v1%',
  'handler persists geocode request lineage'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%geocoding_resolve_policy_for_run%'
    AND pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
      LIKE '%geocoding_get_plugin%',
  'handler resolves short-address geocoding policy from the workflow context'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%reverse_geocode_on_hit%'
    AND pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
      LIKE '%reverse_geocode%',
  'handler carries policy-backed reverse geocode intent for short-code coordinate hits'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
    LIKE '%sa_short_code%'
    AND pg_get_functiondef('workflow_handlers.execute_shipment_update_geocode_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure)
      LIKE '%provided_coordinates%',
  'handler carries Saudi short national address and provided coordinates into nested geocoding context'
);

SELECT finish();
ROLLBACK;
