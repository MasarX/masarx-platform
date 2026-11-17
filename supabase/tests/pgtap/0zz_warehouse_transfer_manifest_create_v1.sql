BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_function(
  'public',
  'create_warehouse_transfer_manifest_v1',
  ARRAY['jsonb'],
  'public.create_warehouse_transfer_manifest_v1 exists'
);

SELECT has_function(
  'api',
  'create_warehouse_transfer_manifest_v1',
  ARRAY['jsonb'],
  'api.create_warehouse_transfer_manifest_v1 exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.create_warehouse_transfer_manifest_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE public.create_warehouse_transfer_manifest_v1(jsonb)'
);

SELECT ok(
  has_function_privilege('service_role', 'public.create_warehouse_transfer_manifest_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE public.create_warehouse_transfer_manifest_v1(jsonb)'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.create_warehouse_transfer_manifest_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE public.create_warehouse_transfer_manifest_v1(jsonb)'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.create_warehouse_transfer_manifest_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE api.create_warehouse_transfer_manifest_v1(jsonb)'
);

SELECT ok(
  has_function_privilege('service_role', 'api.create_warehouse_transfer_manifest_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE api.create_warehouse_transfer_manifest_v1(jsonb)'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.create_warehouse_transfer_manifest_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE api.create_warehouse_transfer_manifest_v1(jsonb)'
);

SELECT * FROM finish();

ROLLBACK;
