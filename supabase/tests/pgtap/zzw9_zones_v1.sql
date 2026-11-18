-- pgTAP: zone_create_v1 + zone_district_add_v1 + zone_district_remove_v1 contract (W9 NETWORK closure)
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

-- 1) zone_create_v1 exists
SELECT ok(
  to_regprocedure('public.zone_create_v1(jsonb)') IS NOT NULL,
  'public.zone_create_v1(jsonb) exists'
);

-- 2) zone_create_v1 least-privilege grants
SELECT ok(
  has_function_privilege('authenticated', 'public.zone_create_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.zone_create_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.zone_create_v1(jsonb)', 'EXECUTE'),
  'zone_create_v1 grants are least-privilege (auth+service yes, anon no)'
);

-- 3) zone_create_v1 capability gate + canonical telemetry
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.zone_create_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''zones\.write'''
  AND pg_get_functiondef(to_regprocedure('public.zone_create_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.zone_create_v1(jsonb)')) ~ 'log_decision\(',
  'zone_create_v1 enforces zones.write + emits domain_event + decision_log'
);

-- 4) zone_create_v1 envelope contract (zone_id key)
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.zone_create_v1(jsonb)')) ~ '''zone_id'',\s*v_zone_id',
  'zone_create_v1 returns zone_id in envelope'
);

-- 5) zone_district_add_v1 exists
SELECT ok(
  to_regprocedure('public.zone_district_add_v1(jsonb)') IS NOT NULL,
  'public.zone_district_add_v1(jsonb) exists'
);

-- 6) zone_district_add_v1 least-privilege grants
SELECT ok(
  has_function_privilege('authenticated', 'public.zone_district_add_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.zone_district_add_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.zone_district_add_v1(jsonb)', 'EXECUTE'),
  'zone_district_add_v1 grants are least-privilege (auth+service yes, anon no)'
);

-- 7) zone_district_add_v1 capability gate + telemetry
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.zone_district_add_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''zones\.write'''
  AND pg_get_functiondef(to_regprocedure('public.zone_district_add_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.zone_district_add_v1(jsonb)')) ~ 'log_decision\(',
  'zone_district_add_v1 enforces zones.write + emits domain_event + decision_log'
);

-- 8) zone_district_add_v1 idempotence path
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.zone_district_add_v1(jsonb)')) ~ 'already_processed',
  'zone_district_add_v1 returns already_processed for idempotent path'
);

-- 9) zone_district_remove_v1 exists
SELECT ok(
  to_regprocedure('public.zone_district_remove_v1(jsonb)') IS NOT NULL,
  'public.zone_district_remove_v1(jsonb) exists'
);

-- 10) zone_district_remove_v1 least-privilege grants
SELECT ok(
  has_function_privilege('authenticated', 'public.zone_district_remove_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.zone_district_remove_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.zone_district_remove_v1(jsonb)', 'EXECUTE'),
  'zone_district_remove_v1 grants are least-privilege (auth+service yes, anon no)'
);

-- 11) zone_district_remove_v1 capability gate + telemetry
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.zone_district_remove_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''zones\.write'''
  AND pg_get_functiondef(to_regprocedure('public.zone_district_remove_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.zone_district_remove_v1(jsonb)')) ~ 'log_decision\(',
  'zone_district_remove_v1 enforces zones.write + emits domain_event + decision_log'
);

-- 12) zone_district_remove_v1 idempotence path (already_removed envelope)
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.zone_district_remove_v1(jsonb)')) ~ 'already_processed'
  AND pg_get_functiondef(to_regprocedure('public.zone_district_remove_v1(jsonb)')) ~ 'already_removed',
  'zone_district_remove_v1 returns already_processed=true with already_removed outcome'
);

-- 13) RLS enabled on canonical underlying tables
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.zones'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.zone_districts'::regclass),
  'public.zones and public.zone_districts have RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
