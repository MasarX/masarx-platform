-- pgTAP: Console V2 COD summary API wrapper contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

SELECT has_function(
  'api',
  'compute_cod_payment_collection_summary_v1',
  ARRAY['uuid', 'uuid', 'text', 'uuid', 'timestamp with time zone', 'timestamp with time zone'],
  'api.compute_cod_payment_collection_summary_v1 browser wrapper is registered'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'api'
      AND p.proname = 'compute_cod_payment_collection_summary_v1'
    LIMIT 1),
  true,
  'api.compute_cod_payment_collection_summary_v1 is SECURITY DEFINER'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.compute_cod_payment_collection_summary_v1(uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone)',
    'EXECUTE'
  ),
  'authenticated can execute api.compute_cod_payment_collection_summary_v1'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'api.compute_cod_payment_collection_summary_v1(uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone)',
    'EXECUTE'
  ),
  'service_role can execute api.compute_cod_payment_collection_summary_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.compute_cod_payment_collection_summary_v1(uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone)',
    'EXECUTE'
  ),
  'anon cannot execute api.compute_cod_payment_collection_summary_v1'
);

SELECT throws_ok(
  $$ SELECT api.compute_cod_payment_collection_summary_v1(NULL, NULL, NULL, NULL, NULL, NULL) $$,
  '42501',
  NULL,
  'unauthenticated callers fail closed before COD summary read'
);

SELECT ok(
  obj_description(
    to_regprocedure('api.compute_cod_payment_collection_summary_v1(uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone)'),
    'pg_proc'
  ) LIKE '%Requires cod.read%',
  'wrapper comment documents cod.read guard'
);

SELECT * FROM finish();
ROLLBACK;
