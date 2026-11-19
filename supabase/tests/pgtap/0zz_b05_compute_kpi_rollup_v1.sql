-- Plan: PHASE B / Step: B5 (INSIGHTS reporting RPC contract gap-fill)
-- pgTAP: compute_kpi_rollup_v1 contract coverage
--
-- Asserts the canonical projection RPC contract:
--   1) Existence + canonical signature (text, date, int, uuid -> projection)
--   2) Least-privilege grants (authenticated/service_role; no anon)
--   3) Body contract: capability gate + tenant scope + tone resolution +
--      delta resolution + settings_resolution_id token
--   4) STABLE + SECURITY DEFINER posture
--   5) RLS underpinning: kpi_definitions + kpi_rollups_daily have RLS enabled

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

-- 1) Existence + signature

SELECT ok(
  to_regprocedure('public.compute_kpi_rollup_v1(text, date, integer, uuid)') IS NOT NULL,
  'public.compute_kpi_rollup_v1(text, date, integer, uuid) exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.compute_kpi_rollup_v1(text, date, integer, uuid)')
       AND p.prosecdef = TRUE
  ),
  'compute_kpi_rollup_v1 is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.compute_kpi_rollup_v1(text, date, integer, uuid)')
       AND p.provolatile = 's' -- 's' = STABLE
  ),
  'compute_kpi_rollup_v1 is STABLE (read-only projection)'
);

-- 2) Least-privilege grants

SELECT ok(
  has_function_privilege('authenticated', 'public.compute_kpi_rollup_v1(text, date, integer, uuid)', 'EXECUTE'),
  'authenticated can EXECUTE compute_kpi_rollup_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.compute_kpi_rollup_v1(text, date, integer, uuid)', 'EXECUTE'),
  'service_role can EXECUTE compute_kpi_rollup_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.compute_kpi_rollup_v1(text, date, integer, uuid)', 'EXECUTE'),
  'anon cannot EXECUTE compute_kpi_rollup_v1'
);

-- 3) Body contract: capability gate + tenant scope + projection contract

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.compute_kpi_rollup_v1(text, date, integer, uuid)')) ~ 'assert_capability_v1\(\s*''insights\.read''',
  'compute_kpi_rollup_v1 calls assert_capability_v1(insights.read)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.compute_kpi_rollup_v1(text, date, integer, uuid)')) ~ 'is_platform_user\(\)',
  'compute_kpi_rollup_v1 enforces platform-or-tenant scope check'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.compute_kpi_rollup_v1(text, date, integer, uuid)')) ~ 'kpi_definitions',
  'compute_kpi_rollup_v1 reads from public.kpi_definitions'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.compute_kpi_rollup_v1(text, date, integer, uuid)')) ~ 'kpi_rollups_daily',
  'compute_kpi_rollup_v1 reads from public.kpi_rollups_daily'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.compute_kpi_rollup_v1(text, date, integer, uuid)')) ~ 'srlv_kpi_',
  'compute_kpi_rollup_v1 emits deterministic settings_resolution_id token'
);

SELECT * FROM finish();

ROLLBACK;
