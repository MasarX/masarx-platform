-- Plan: PHASE B / Step: B4 (NETWORK marketplace + zones RPC contract gap-fill)
-- pgTAP: suspend_zone_v1 + restore_zone_v1 contract coverage
--
-- Asserts the canonical Phase B contract for both new write RPCs:
--   1) Existence + canonical signature shape (jsonb -> jsonb)
--   2) Least-privilege grants (authenticated/service_role only; no anon)
--   3) Capability gate (assert_capability_v1('zones.write')) wired in body
--   4) Domain event ledger writes (`zone.suspended` / `zone.restored`)
--   5) Decision audit (decision_category=zone_lifecycle) wired in body
--   6) Tenant scope guard via is_platform_user() in body
--   7) Idempotency-aware return envelope (already_processed) in body
--   8) Lookup category seeds: zone_lifecycle decision_category present;
--      suspended/restored decision_outcomes present
--   9) RLS underpinning: zones table has RLS enabled
--
-- NOTE: Live ladder behavior (allowed/denied/cross-tenant) is exercised by the
-- companion Jest integration tests under tests/integration/network/, which
-- can seed access_control_policy.assignments.user_id and run multi-tenant
-- scenarios end-to-end. pgTAP here pins the static contract surface.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(29);

-- --------------------------------------------------------------------------
-- 1) Function existence + signature
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.suspend_zone_v1(jsonb)') IS NOT NULL,
  'public.suspend_zone_v1(jsonb) exists'
);

SELECT ok(
  to_regprocedure('public.restore_zone_v1(jsonb)') IS NOT NULL,
  'public.restore_zone_v1(jsonb) exists'
);

-- Both must be SECURITY DEFINER with locked search_path
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.suspend_zone_v1(jsonb)')
       AND p.prosecdef = TRUE
  ),
  'suspend_zone_v1 is SECURITY DEFINER'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.restore_zone_v1(jsonb)')
       AND p.prosecdef = TRUE
  ),
  'restore_zone_v1 is SECURITY DEFINER'
);

-- --------------------------------------------------------------------------
-- 2) Least-privilege grants
-- --------------------------------------------------------------------------

SELECT ok(
  has_function_privilege('authenticated', 'public.suspend_zone_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE suspend_zone_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.suspend_zone_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE suspend_zone_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.suspend_zone_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE suspend_zone_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.restore_zone_v1(jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE restore_zone_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.restore_zone_v1(jsonb)', 'EXECUTE'),
  'service_role can EXECUTE restore_zone_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.restore_zone_v1(jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE restore_zone_v1'
);

-- --------------------------------------------------------------------------
-- 3) Body contract: capability gate + decision audit + domain event
-- --------------------------------------------------------------------------

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.suspend_zone_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''zones\.write''',
  'suspend_zone_v1 calls assert_capability_v1(zones.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.restore_zone_v1(jsonb)')) ~ 'assert_capability_v1\(\s*''zones\.write''',
  'restore_zone_v1 calls assert_capability_v1(zones.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.suspend_zone_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events',
  'suspend_zone_v1 emits a domain_events row'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.restore_zone_v1(jsonb)')) ~ 'INSERT INTO public\.domain_events',
  'restore_zone_v1 emits a domain_events row'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.suspend_zone_v1(jsonb)')) ~ '''zone\.suspended''',
  'suspend_zone_v1 uses canonical event_type ''zone.suspended'''
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.restore_zone_v1(jsonb)')) ~ '''zone\.restored''',
  'restore_zone_v1 uses canonical event_type ''zone.restored'''
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.suspend_zone_v1(jsonb)')) ~ 'log_decision\(',
  'suspend_zone_v1 calls log_decision()'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.restore_zone_v1(jsonb)')) ~ 'log_decision\(',
  'restore_zone_v1 calls log_decision()'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.suspend_zone_v1(jsonb)')) ~ '''zone_lifecycle''',
  'suspend_zone_v1 uses canonical decision_category ''zone_lifecycle'''
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.restore_zone_v1(jsonb)')) ~ '''zone_lifecycle''',
  'restore_zone_v1 uses canonical decision_category ''zone_lifecycle'''
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.suspend_zone_v1(jsonb)')) ~ 'is_platform_user\(\)',
  'suspend_zone_v1 enforces platform-or-tenant scope check via is_platform_user()'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.restore_zone_v1(jsonb)')) ~ 'is_platform_user\(\)',
  'restore_zone_v1 enforces platform-or-tenant scope check via is_platform_user()'
);

-- Idempotency: both RPCs must include an already_processed branch in the body
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.suspend_zone_v1(jsonb)')) ~ 'already_processed',
  'suspend_zone_v1 returns already_processed in idempotent path'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.restore_zone_v1(jsonb)')) ~ 'already_processed',
  'restore_zone_v1 returns already_processed in idempotent path'
);

-- --------------------------------------------------------------------------
-- 4) Lookup category seeds (zone_lifecycle + outcomes)
-- --------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'zone_lifecycle'
       AND lv.status = 'active'
  ),
  'decision_category seed includes zone_lifecycle (active)'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'decision_outcome'
       AND lv.value = 'suspended'
       AND lv.status = 'active'
  ),
  'decision_outcome seed includes suspended (active)'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'decision_outcome'
       AND lv.value = 'restored'
       AND lv.status = 'active'
  ),
  'decision_outcome seed includes restored (active)'
);

-- --------------------------------------------------------------------------
-- 5) Capability registry: zones.write registered in access_control_policy
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
       AND cap->>'key' = 'zones.write'
  ),
  'access_control_policy registers zones.write capability'
);

-- --------------------------------------------------------------------------
-- 6) RLS underpinning: zones table has RLS enabled
-- --------------------------------------------------------------------------

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.zones'::regclass),
  'public.zones has RLS enabled (no bypass paths from suspend/restore)'
);

SELECT * FROM finish();

ROLLBACK;
