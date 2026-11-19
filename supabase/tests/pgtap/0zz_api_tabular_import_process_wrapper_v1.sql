BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

SELECT has_function(
  'api',
  'process_tabular_import_run_v1',
  ARRAY['uuid', 'integer'],
  'api.process_tabular_import_run_v1 exists for edge import processing'
);

SELECT function_owner_is(
  'api',
  'process_tabular_import_run_v1',
  ARRAY['uuid', 'integer'],
  'postgres',
  'api.process_tabular_import_run_v1 owner remains postgres'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'api.process_tabular_import_run_v1(uuid, integer)',
    'EXECUTE'
  ),
  'service_role can execute api.process_tabular_import_run_v1'
);

SELECT * FROM finish();

ROLLBACK;
