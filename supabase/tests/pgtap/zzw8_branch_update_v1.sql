-- pgTAP: public.branch_update_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT ok(
  to_regprocedure('public.branch_update_v1(jsonb)') IS NOT NULL,
  'public.branch_update_v1(jsonb) exists'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.branch_update_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.branch_update_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.branch_update_v1(jsonb)', 'EXECUTE'),
  'branch_update_v1 grants are least-privilege'
);
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_update_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''branches\.write'''
  AND pg_get_functiondef(to_regprocedure('public.branch_update_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.branch_update_v1(jsonb)')) ~ 'log_decision\(',
  'branch_update_v1 enforces branches.write + emits domain_event + decision_log'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.branches'::regclass),
  'public.branches has RLS enabled'
);
SELECT * FROM finish();
ROLLBACK;
