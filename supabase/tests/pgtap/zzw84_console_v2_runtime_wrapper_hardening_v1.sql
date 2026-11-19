BEGIN;

SELECT plan(24);

SELECT has_function(
  'api',
  'list_delivery_slots_v1',
  ARRAY['jsonb'],
  'api.list_delivery_slots_v1(jsonb) is registered'
);
SELECT has_function(
  'api',
  'reserve_delivery_slot_v1',
  ARRAY['jsonb'],
  'api.reserve_delivery_slot_v1(jsonb) is registered'
);
SELECT has_function(
  'api',
  'route_run_scan_out_reconciliation_v1',
  ARRAY['uuid'],
  'api.route_run_scan_out_reconciliation_v1(uuid) is registered'
);

SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('api.list_delivery_slots_v1(jsonb)')),
  TRUE,
  'api.list_delivery_slots_v1 is SECURITY DEFINER'
);
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('api.reserve_delivery_slot_v1(jsonb)')),
  TRUE,
  'api.reserve_delivery_slot_v1 is SECURITY DEFINER'
);
SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('api.route_run_scan_out_reconciliation_v1(uuid)')),
  TRUE,
  'api.route_run_scan_out_reconciliation_v1 is SECURITY DEFINER'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.list_delivery_slots_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.list_delivery_slots_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.reserve_delivery_slot_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.reserve_delivery_slot_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.route_run_scan_out_reconciliation_v1(uuid)', 'EXECUTE'),
  'authenticated can execute api.route_run_scan_out_reconciliation_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.list_delivery_slots_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.list_delivery_slots_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.reserve_delivery_slot_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.reserve_delivery_slot_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.route_run_scan_out_reconciliation_v1(uuid)', 'EXECUTE'),
  'anon cannot execute api.route_run_scan_out_reconciliation_v1'
);

SELECT ok(
  position('ui_get_resource_v1(''shipments''' in pg_get_functiondef(to_regprocedure('api.list_delivery_slots_v1(jsonb)'))) > 0,
  'slot listing wrapper checks shipment visibility'
);
SELECT ok(
  position('ui_get_resource_v1(''shipments''' in pg_get_functiondef(to_regprocedure('api.reserve_delivery_slot_v1(jsonb)'))) > 0,
  'slot reservation wrapper checks shipment visibility'
);
SELECT ok(
  position('ui_get_resource_v1(''route_runs''' in pg_get_functiondef(to_regprocedure('api.route_run_scan_out_reconciliation_v1(uuid)'))) > 0,
  'scan-out wrapper checks route-run visibility'
);

SELECT ok(
  position('assert_capability_v1(' in pg_get_functiondef(to_regprocedure('api.reserve_delivery_slot_v1(jsonb)'))) > 0,
  'slot reservation wrapper asserts capability'
);
SELECT ok(
  position('''shipments.write''' in pg_get_functiondef(to_regprocedure('api.reserve_delivery_slot_v1(jsonb)'))) > 0,
  'slot reservation wrapper asserts shipments.write'
);
SELECT ok(
  position('assert_capability_v1(' in pg_get_functiondef(to_regprocedure('api.route_run_scan_out_reconciliation_v1(uuid)'))) > 0,
  'scan-out wrapper asserts capability'
);
SELECT ok(
  position('''routes.read''' in pg_get_functiondef(to_regprocedure('api.route_run_scan_out_reconciliation_v1(uuid)'))) > 0,
  'scan-out wrapper asserts routes.read'
);

SELECT throws_ok(
  $$ SELECT count(*) FROM api.list_delivery_slots_v1('{}'::jsonb) $$,
  '22023',
  NULL,
  'slot listing fails closed without shipment_id'
);
SELECT throws_ok(
  $$ SELECT api.reserve_delivery_slot_v1('{}'::jsonb) $$,
  '22023',
  NULL,
  'slot reservation fails closed without shipment_id'
);
SELECT throws_ok(
  $$ SELECT api.route_run_scan_out_reconciliation_v1(NULL::uuid) $$,
  '22023',
  NULL,
  'scan-out reconciliation fails closed without route_run_id'
);

SELECT ok(
  position('public.list_delivery_slots_v1(v_input)' in pg_get_functiondef(to_regprocedure('api.list_delivery_slots_v1(jsonb)'))) > 0,
  'slot listing delegates to canonical public helper after guards'
);
SELECT ok(
  position('public.reserve_delivery_slot_v1(v_input)' in pg_get_functiondef(to_regprocedure('api.reserve_delivery_slot_v1(jsonb)'))) > 0,
  'slot reservation delegates to canonical public helper after guards'
);

SELECT * FROM finish();

ROLLBACK;
