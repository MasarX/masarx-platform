BEGIN;
SELECT plan(4);

SELECT has_function(
  'api',
  'pickup_vehicle_lookup_v1',
  ARRAY['uuid', 'integer'],
  'api.pickup_vehicle_lookup_v1 exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.pickup_vehicle_lookup_v1(uuid, integer)',
    'EXECUTE'
  ),
  'authenticated can EXECUTE api.pickup_vehicle_lookup_v1(uuid, integer)'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'api.pickup_vehicle_lookup_v1(uuid, integer)',
    'EXECUTE'
  ),
  'service_role can EXECUTE api.pickup_vehicle_lookup_v1(uuid, integer)'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.pickup_vehicle_lookup_v1(uuid, integer)',
    'EXECUTE'
  ),
  'anon cannot EXECUTE api.pickup_vehicle_lookup_v1(uuid, integer)'
);

SELECT * FROM finish();
ROLLBACK;
