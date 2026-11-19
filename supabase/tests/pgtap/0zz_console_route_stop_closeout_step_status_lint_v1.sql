-- pgTAP: Console route-stop closeout readback uses canonical workflow step status column.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(3);

SELECT has_function(
  'api',
  'ui_finalize_route_stop_closeout_event_v1',
  ARRAY['uuid', 'integer'],
  'api.ui_finalize_route_stop_closeout_event_v1 exists'
);

SELECT ok(
  pg_get_functiondef('api.ui_finalize_route_stop_closeout_event_v1(uuid,integer)'::regprocedure)
    LIKE '%wrs.step_status = ''failed''%',
  'Console route-stop closeout failed-step readback uses workflow_run_steps.step_status'
);

SELECT ok(
  pg_get_functiondef('api.ui_finalize_route_stop_closeout_event_v1(uuid,integer)'::regprocedure)
    NOT LIKE '%wrs.status = ''failed''%',
  'Console route-stop closeout readback does not reference missing workflow_run_steps.status'
);

SELECT * FROM finish();

ROLLBACK;
