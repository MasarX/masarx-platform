-- pgTAP: branch_capacity_window_set_v1 + branch_coverage_window_upsert_v1 contract (W9 NETWORK closure)
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) capacity_set exists
SELECT ok(
  to_regprocedure('public.branch_capacity_window_set_v1(jsonb)') IS NOT NULL,
  'public.branch_capacity_window_set_v1(jsonb) exists'
);

-- 2) capacity_set least-privilege grants (allowed/denied gate)
SELECT ok(
  has_function_privilege('authenticated', 'public.branch_capacity_window_set_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.branch_capacity_window_set_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.branch_capacity_window_set_v1(jsonb)', 'EXECUTE'),
  'branch_capacity_window_set_v1 grants are least-privilege (auth+service yes, anon no)'
);

-- 3) capacity_set capability gate + canonical telemetry
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_capacity_window_set_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''branches\.write'''
  AND pg_get_functiondef(to_regprocedure('public.branch_capacity_window_set_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.branch_capacity_window_set_v1(jsonb)')) ~ 'log_decision\(',
  'branch_capacity_window_set_v1 enforces branches.write + emits domain_event + decision_log'
);

-- 4) capacity_set idempotence (already_processed for no-op)
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_capacity_window_set_v1(jsonb)')) ~ 'already_processed',
  'branch_capacity_window_set_v1 returns already_processed for idempotent path'
);

-- 5) coverage_upsert exists
SELECT ok(
  to_regprocedure('public.branch_coverage_window_upsert_v1(jsonb)') IS NOT NULL,
  'public.branch_coverage_window_upsert_v1(jsonb) exists'
);

-- 6) coverage_upsert least-privilege grants
SELECT ok(
  has_function_privilege('authenticated', 'public.branch_coverage_window_upsert_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.branch_coverage_window_upsert_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.branch_coverage_window_upsert_v1(jsonb)', 'EXECUTE'),
  'branch_coverage_window_upsert_v1 grants are least-privilege (auth+service yes, anon no)'
);

-- 7) coverage_upsert capability gate + canonical telemetry
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_coverage_window_upsert_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''branches\.write'''
  AND pg_get_functiondef(to_regprocedure('public.branch_coverage_window_upsert_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.branch_coverage_window_upsert_v1(jsonb)')) ~ 'log_decision\(',
  'branch_coverage_window_upsert_v1 enforces branches.write + emits domain_event + decision_log'
);

-- 8) RLS enabled on canonical underlying tables
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.branch_capacity_windows'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.branch_coverage_windows'::regclass),
  'public.branch_capacity_windows and public.branch_coverage_windows have RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
