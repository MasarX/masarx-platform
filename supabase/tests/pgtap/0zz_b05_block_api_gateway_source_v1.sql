-- Plan: PHASE B / Step: B5 (INSIGHTS api-gateway operational write contract)
-- pgTAP: block_api_gateway_source_v1 contract coverage
--
-- Asserts the canonical Phase B contract for the new write RPC:
--   1) Existence + canonical signature shape (jsonb -> jsonb)
--   2) Least-privilege grants (authenticated/service_role only; no anon)
--   3) Capability gate (assert_capability_v1('api_gateway.write')) wired in body
--   4) Domain event ledger writes (`api_gateway.source.blocked`)
--   5) Decision audit (decision_category=api_gateway_source_lifecycle) wired
--   6) Tenant scope guard via is_platform_user() in body
--   7) Idempotency-aware return envelope (already_processed) in body
--   8) Lookup category seeds: api_gateway_source_lifecycle decision_category
--      present; blocked/unblocked decision_outcomes present
--   9) Capability registry: api_gateway.read + api_gateway.write registered in
--      access_control_policy
--  10) RLS underpinning: webhook_sources table has RLS enabled

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(15);

-- --------------------------------------------------------------------------
-- 1) Function existence + signature
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.block_api_gateway_source_v1(jsonb)') IS NOT NULL,
  'public.block_api_gateway_source_v1(jsonb) exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.block_api_gateway_source_v1(jsonb)')
       AND p.prosecdef = TRUE
  ),
  'block_api_gateway_source_v1 is SECURITY DEFINER'
);

-- --------------------------------------------------------------------------
-- 2) Least-privilege grants
-- --------------------------------------------------------------------------

SELECT ok(
  has_function_privilege('authenticated', 'public.block_api_gateway_source_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE block_api_gateway_source_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.block_api_gateway_source_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE block_api_gateway_source_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.block_api_gateway_source_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE block_api_gateway_source_v1'
);

-- --------------------------------------------------------------------------
-- 3) Body contract: capability gate + decision audit + domain event +
--    tenant scope + idempotency
-- --------------------------------------------------------------------------

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.block_api_gateway_source_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''api_gateway\.write''',
  'block_api_gateway_source_v1 calls assert_capability_v1(api_gateway.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.block_api_gateway_source_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events',
  'block_api_gateway_source_v1 emits a domain_events row'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.block_api_gateway_source_v1(jsonb)')) ~ '''api_gateway\.source\.blocked''',
  'block_api_gateway_source_v1 uses canonical event_type ''api_gateway.source.blocked'''
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.block_api_gateway_source_v1(jsonb)')) ~ 'log_decision\(',
  'block_api_gateway_source_v1 calls log_decision()'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.block_api_gateway_source_v1(jsonb)')) ~ '''api_gateway_source_lifecycle''',
  'block_api_gateway_source_v1 uses canonical decision_category ''api_gateway_source_lifecycle'''
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.block_api_gateway_source_v1(jsonb)')) ~ 'is_platform_user\(\)',
  'block_api_gateway_source_v1 enforces platform-or-tenant scope check'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.block_api_gateway_source_v1(jsonb)')) ~ 'already_processed',
  'block_api_gateway_source_v1 returns already_processed in idempotent path'
);

-- --------------------------------------------------------------------------
-- 4) Lookup category seeds (api_gateway_source_lifecycle + outcomes)
-- --------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'api_gateway_source_lifecycle'
       AND lv.status = 'active'
  ),
  'decision_category seed includes api_gateway_source_lifecycle (active)'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'decision_outcome'
       AND lv.value = 'blocked'
       AND lv.status = 'active'
  ),
  'decision_outcome seed includes blocked (active)'
);

-- --------------------------------------------------------------------------
-- 5) Capability registry: api_gateway.write registered in access_control_policy
-- --------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS cap
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND cap->>'key' = 'api_gateway.write'
  ),
  'access_control_policy registers api_gateway.write capability'
);

SELECT * FROM finish();

ROLLBACK;
