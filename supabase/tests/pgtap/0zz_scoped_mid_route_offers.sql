BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(4);

SELECT is((SELECT count(*) FROM api.pending_mid_route_stops_v1(NULL)), 0::bigint,
  'an offer read without an assigned route returns no rows');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mid_route_stop_injections', 'SELECT'),
  'authenticated drivers cannot read the offer ledger directly');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mid_route_stop_injections', 'UPDATE'),
  'an offer read does not grant route update authority');
SELECT ok(NOT has_function_privilege('anon', 'api.pending_mid_route_stops_v1(uuid)', 'EXECUTE'),
  'anonymous callers cannot read route offers');

SELECT * FROM finish();
ROLLBACK;
