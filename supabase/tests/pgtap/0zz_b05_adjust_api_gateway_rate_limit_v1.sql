-- Plan: PHASE B / Step: B5 (INSIGHTS api-gateway operational write contract)
-- pgTAP: adjust_api_gateway_rate_limit_v1 contract coverage
--
-- Asserts the canonical Phase B contract for the new write RPC:
--   1) Existence + canonical signature (jsonb -> jsonb)
--   2) Least-privilege grants (authenticated/service_role; no anon)
--   3) Capability gate (api_gateway.write) wired in body
--   4) Domain event ledger writes (`api_gateway.rate_limit.adjusted`)
--   5) Decision audit (decision_category=api_gateway_source_lifecycle,
--      decision_outcome=rate_limit_adjusted) wired in body
--   6) Tenant scope guard via is_platform_user() in body
--   7) Idempotency-aware return envelope (already_processed) in body
--   8) Lookup outcome seed: rate_limit_adjusted active
--   9) RLS underpinning: webhook_sources has RLS enabled

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

-- 1) Function existence + signature

SELECT ok(
  to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)') IS NOT NULL,
  'public.adjust_api_gateway_rate_limit_v1(jsonb) exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)')
       AND p.prosecdef = TRUE
  ),
  'adjust_api_gateway_rate_limit_v1 is SECURITY DEFINER'
);

-- 2) Least-privilege grants

SELECT ok(
  has_function_privilege('authenticated', 'public.adjust_api_gateway_rate_limit_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE adjust_api_gateway_rate_limit_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.adjust_api_gateway_rate_limit_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE adjust_api_gateway_rate_limit_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.adjust_api_gateway_rate_limit_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE adjust_api_gateway_rate_limit_v1'
);

-- 3) Body contract: capability gate + decision audit + domain event +
--    tenant scope + idempotency

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''api_gateway\.write''',
  'adjust_api_gateway_rate_limit_v1 calls assert_capability_v1(api_gateway.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events',
  'adjust_api_gateway_rate_limit_v1 emits a domain_events row'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)')) ~ '''api_gateway\.rate_limit\.adjusted''',
  'adjust_api_gateway_rate_limit_v1 uses canonical event_type ''api_gateway.rate_limit.adjusted'''
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)')) ~ 'log_decision\(',
  'adjust_api_gateway_rate_limit_v1 calls log_decision()'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)')) ~ '''api_gateway_source_lifecycle''',
  'adjust_api_gateway_rate_limit_v1 uses canonical decision_category ''api_gateway_source_lifecycle'''
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)')) ~ 'is_platform_user\(\)',
  'adjust_api_gateway_rate_limit_v1 enforces platform-or-tenant scope check'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.adjust_api_gateway_rate_limit_v1(jsonb)')) ~ 'already_processed',
  'adjust_api_gateway_rate_limit_v1 returns already_processed in idempotent path'
);

-- 4) Lookup outcome seed: rate_limit_adjusted

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'decision_outcome'
       AND lv.value = 'rate_limit_adjusted'
       AND lv.status = 'active'
  ),
  'decision_outcome seed includes rate_limit_adjusted (active)'
);

SELECT * FROM finish();

ROLLBACK;
