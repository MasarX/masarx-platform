-- pgTAP: add_branch_member_v1 + remove_branch_member_v1 contract (W9 NETWORK closure)
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) function exists
SELECT ok(
  to_regprocedure('public.add_branch_member_v1(jsonb)') IS NOT NULL,
  'public.add_branch_member_v1(jsonb) exists'
);

-- 2) least-privilege grants (allowed/denied gate)
SELECT ok(
  has_function_privilege('authenticated', 'public.add_branch_member_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.add_branch_member_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.add_branch_member_v1(jsonb)', 'EXECUTE'),
  'add_branch_member_v1 grants are least-privilege (auth+service yes, anon no)'
);

-- 3) capability gate + canonical telemetry surfaces
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''agreements\.write'''
  AND pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''agreements\.write'',\s*''tenant'''
  AND pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)')) ~ 'log_decision\(',
  'add_branch_member_v1 checks agreement write access and records tenant membership evidence'
);

-- 4) idempotence path (already_processed envelope)
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)')) ~ 'already_processed',
  'add_branch_member_v1 returns already_processed for idempotent path'
);

-- 5) function exists (remove)
SELECT ok(
  to_regprocedure('public.remove_branch_member_v1(jsonb)') IS NOT NULL,
  'public.remove_branch_member_v1(jsonb) exists'
);

-- 6) least-privilege grants (remove)
SELECT ok(
  has_function_privilege('authenticated', 'public.remove_branch_member_v1(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.remove_branch_member_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.remove_branch_member_v1(jsonb)', 'EXECUTE'),
  'remove_branch_member_v1 grants are least-privilege (auth+service yes, anon no)'
);

-- 7) capability gate + canonical telemetry surfaces (remove)
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.remove_branch_member_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''branches\.write'''
  AND pg_get_functiondef(to_regprocedure('public.remove_branch_member_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events'
  AND pg_get_functiondef(to_regprocedure('public.remove_branch_member_v1(jsonb)')) ~ 'log_decision\(',
  'remove_branch_member_v1 enforces branches.write + emits domain_event + decision_log'
);

-- 8) RLS enabled on canonical underlying tables
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.branch_memberships'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.branches'::regclass),
  'public.branch_memberships and public.branches have RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
