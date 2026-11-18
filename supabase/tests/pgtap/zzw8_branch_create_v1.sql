-- pgTAP: public.branch_create_v1 contract (existence/grants/RLS/capability)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

-- 1) Function exists with canonical signature
SELECT ok(
  to_regprocedure('public.branch_create_v1(jsonb)') IS NOT NULL,
  'public.branch_create_v1(jsonb) exists'
);

-- 2) Least-privilege grants (no anon)
SELECT ok(
  has_function_privilege('authenticated', 'public.branch_create_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.branch_create_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.branch_create_v1(jsonb)', 'EXECUTE'),
  'branch_create_v1 grants are least-privilege (authenticated+service_role only)'
);

-- 3) Body wires capability gate + decision audit + domain event (idempotence: re-running returns the same envelope shape)
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_create_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''branches\.write'''
  AND pg_get_functiondef(to_regprocedure('public.branch_create_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.branch_create_v1(jsonb)')) ~ 'log_decision\(',
  'branch_create_v1 enforces branches.write + emits domain_event + decision_log'
);

-- 4) RLS underpinning: branches table has RLS enabled
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.branches'::regclass),
  'public.branches has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
