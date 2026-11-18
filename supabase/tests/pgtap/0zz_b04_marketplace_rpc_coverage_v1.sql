-- Plan: PHASE B / Step: B4 (NETWORK marketplace + zones RPC coverage)
-- pgTAP: Marketplace canonical write-RPC coverage
-- Purpose: assert that every canonical marketplace write RPC referenced by
-- the NETWORK FE crosswalk audit (§1.4) exists with the canonical signature
-- and is locked down (no anon access; least-privilege grants) per AGENTS.md
-- objectives. Covers RPCs identified in audit but lacking pgTAP coverage:
--   - marketplace_offer_submit_v1
--   - marketplace_offer_withdraw_v1
--   - marketplace_award_offer_v1 (canonical name; FE uses invented "marketplace_offer_award_v1")
--   - marketplace_award_respond_v1
--   - marketplace_request_publish_v1
--   - marketplace_request_cancel_v1
--   - marketplace_dispute_open_v1
--   - marketplace_dispute_resolve_v1
--   - marketplace_refresh_reputation_snapshot_v1 (canonical name; FE uses invented "refresh_reputation_snapshot_v1")
-- Existing coverage in 120_marketplace_network and 0zz_marketplace_network_foundation_v1
-- only asserts a subset; this file adds shape, capability-assertion, and grant invariants.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(57);

-- --------------------------------------------------------------------------
-- 1) marketplace_offer_submit_v1
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)') IS NOT NULL,
  'public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamptz,jsonb) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_offer_submit_v1'
);

SELECT ok(
  has_function_privilege('service_role', 'public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'),
  'service_role can EXECUTE marketplace_offer_submit_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_offer_submit_v1'
);

-- --------------------------------------------------------------------------
-- 2) marketplace_offer_withdraw_v1
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_offer_withdraw_v1(uuid,text)') IS NOT NULL,
  'public.marketplace_offer_withdraw_v1(uuid,text) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_offer_withdraw_v1(uuid,text)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_offer_withdraw_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_offer_withdraw_v1(uuid,text)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_offer_withdraw_v1'
);

-- --------------------------------------------------------------------------
-- 3) marketplace_award_offer_v1
--    (audit candidate name `marketplace_offer_award_v1` is invented; canonical
--     name is `marketplace_award_offer_v1`)
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)') IS NOT NULL,
  'public.marketplace_award_offer_v1(uuid,text,jsonb,timestamptz,jsonb) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_award_offer_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_award_offer_v1'
);

-- Confirm the audit's invented name is NOT a real RPC; FE must use canonical name
SELECT ok(
  to_regprocedure('public.marketplace_offer_award_v1(uuid,text,jsonb,timestamp with time zone,jsonb)') IS NULL,
  'public.marketplace_offer_award_v1 (FE-invented alias) does not exist; canonical name is marketplace_award_offer_v1'
);

-- --------------------------------------------------------------------------
-- 4) marketplace_award_respond_v1
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_award_respond_v1(uuid,text,jsonb)') IS NOT NULL,
  'public.marketplace_award_respond_v1(uuid,text,jsonb) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_award_respond_v1(uuid,text,jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_award_respond_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_award_respond_v1(uuid,text,jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_award_respond_v1'
);

-- --------------------------------------------------------------------------
-- 5) marketplace_request_create_v1 (canonical signature shape + grant lockdown)
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)') IS NOT NULL,
  'public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamptz,jsonb) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_request_create_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_request_create_v1'
);

-- --------------------------------------------------------------------------
-- 6) marketplace_request_publish_v1
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_request_publish_v1(uuid,text)') IS NOT NULL,
  'public.marketplace_request_publish_v1(uuid,text) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_request_publish_v1(uuid,text)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_request_publish_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_request_publish_v1(uuid,text)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_request_publish_v1'
);

-- --------------------------------------------------------------------------
-- 7) marketplace_request_cancel_v1
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_request_cancel_v1(uuid,text)') IS NOT NULL,
  'public.marketplace_request_cancel_v1(uuid,text) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_request_cancel_v1(uuid,text)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_request_cancel_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_request_cancel_v1(uuid,text)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_request_cancel_v1'
);

-- --------------------------------------------------------------------------
-- 8) marketplace_dispute_open_v1
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)') IS NOT NULL,
  'public.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_dispute_open_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_dispute_open_v1'
);

-- --------------------------------------------------------------------------
-- 9) marketplace_dispute_resolve_v1 (platform-only at runtime; grant remains
--    to authenticated, runtime gate enforced via assert_capability_v1 +
--    is_platform_user())
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)') IS NOT NULL,
  'public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_dispute_resolve_v1 (gated at runtime)'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_dispute_resolve_v1'
);

-- Body must enforce platform-only gate
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)')) ~ 'is_platform_user\(\)',
  'marketplace_dispute_resolve_v1 enforces is_platform_user() gate'
);

-- --------------------------------------------------------------------------
-- 10) marketplace_work_package_materialize_v1
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)') IS NOT NULL,
  'public.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb) exists'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'authenticated can EXECUTE marketplace_work_package_materialize_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_work_package_materialize_v1(uuid,uuid,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_work_package_materialize_v1'
);

-- --------------------------------------------------------------------------
-- 11) marketplace_participant_request_review_apply_v1
--     (service_role-only because participant onboarding bypasses tenant ladder)
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)') IS NOT NULL,
  'public.marketplace_participant_request_review_apply_v1(...) exists'
);

SELECT ok(
  has_function_privilege('service_role', 'public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)', 'EXECUTE'),
  'service_role can EXECUTE marketplace_participant_request_review_apply_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_participant_request_review_apply_v1(uuid,text,uuid,uuid,boolean,text,uuid,uuid,jsonb)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_participant_request_review_apply_v1'
);

-- --------------------------------------------------------------------------
-- 12) marketplace_refresh_reputation_snapshot_v1
--     (audit candidate name `refresh_reputation_snapshot_v1` is invented;
--      canonical name carries the `marketplace_` prefix and is service-only)
-- --------------------------------------------------------------------------

SELECT ok(
  to_regprocedure('public.marketplace_refresh_reputation_snapshot_v1(uuid)') IS NOT NULL,
  'public.marketplace_refresh_reputation_snapshot_v1(uuid) exists'
);

SELECT ok(
  has_function_privilege('service_role', 'public.marketplace_refresh_reputation_snapshot_v1(uuid)', 'EXECUTE'),
  'service_role can EXECUTE marketplace_refresh_reputation_snapshot_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.marketplace_refresh_reputation_snapshot_v1(uuid)', 'EXECUTE'),
  'anon cannot EXECUTE marketplace_refresh_reputation_snapshot_v1'
);

-- Confirm the audit's invented unprefixed name is NOT a real RPC
SELECT ok(
  to_regprocedure('public.refresh_reputation_snapshot_v1(uuid)') IS NULL,
  'public.refresh_reputation_snapshot_v1 (FE-invented alias) does not exist; canonical name is marketplace_refresh_reputation_snapshot_v1'
);

-- --------------------------------------------------------------------------
-- Capability registry: ensure marketplace write capabilities are registered in
-- access_control_policy settings (canonical SSOT for capability definitions)
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
       AND cap->>'key' = 'marketplace_requests.write'
  ),
  'access_control_policy registers marketplace_requests.write'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS cap
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND cap->>'key' = 'marketplace_offers.write'
  ),
  'access_control_policy registers marketplace_offers.write'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS cap
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND cap->>'key' = 'marketplace_awards.write'
  ),
  'access_control_policy registers marketplace_awards.write'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS cap
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND cap->>'key' = 'marketplace_disputes.write'
  ),
  'access_control_policy registers marketplace_disputes.write'
);

-- --------------------------------------------------------------------------
-- Capability gating: each RPC must call assert_capability_v1 with the
-- domain-correct capability key inside its body (objective: no bypass paths,
-- ladder-driven decisions only)
-- --------------------------------------------------------------------------

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_offer_submit_v1(uuid,text,jsonb,jsonb,timestamp with time zone,jsonb)')) ~ 'assert_capability_v1\(\s*''marketplace_offers\.write''',
  'marketplace_offer_submit_v1 calls assert_capability_v1(marketplace_offers.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_offer_withdraw_v1(uuid,text)')) ~ 'assert_capability_v1\(\s*''marketplace_offers\.write''',
  'marketplace_offer_withdraw_v1 calls assert_capability_v1(marketplace_offers.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_award_offer_v1(uuid,text,jsonb,timestamp with time zone,jsonb)')) ~ 'assert_capability_v1\(\s*''marketplace_awards\.write''',
  'marketplace_award_offer_v1 calls assert_capability_v1(marketplace_awards.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_award_respond_v1(uuid,text,jsonb)')) ~ 'assert_capability_v1\(\s*''marketplace_awards\.write''',
  'marketplace_award_respond_v1 calls assert_capability_v1(marketplace_awards.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_request_create_v1(text,text,text,jsonb,jsonb,jsonb,timestamp with time zone,jsonb)')) ~ 'assert_capability_v1\(\s*''marketplace_requests\.write''',
  'marketplace_request_create_v1 calls assert_capability_v1(marketplace_requests.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_request_publish_v1(uuid,text)')) ~ 'assert_capability_v1\(\s*''marketplace_requests\.write''',
  'marketplace_request_publish_v1 calls assert_capability_v1(marketplace_requests.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_request_cancel_v1(uuid,text)')) ~ 'assert_capability_v1\(\s*''marketplace_requests\.write''',
  'marketplace_request_cancel_v1 calls assert_capability_v1(marketplace_requests.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_dispute_open_v1(uuid,uuid,text,text,text,jsonb)')) ~ 'assert_capability_v1\(\s*''marketplace_disputes\.write''',
  'marketplace_dispute_open_v1 calls assert_capability_v1(marketplace_disputes.write)'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.marketplace_dispute_resolve_v1(uuid,text,text,jsonb)')) ~ 'assert_capability_v1\(\s*''marketplace_disputes\.write''',
  'marketplace_dispute_resolve_v1 calls assert_capability_v1(marketplace_disputes.write)'
);

-- --------------------------------------------------------------------------
-- RLS underpinning: marketplace tables have RLS enabled (no read/write paths
-- bypass the override ladder)
-- --------------------------------------------------------------------------

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.marketplace_offers'::regclass),
  'public.marketplace_offers has RLS enabled'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.marketplace_awards'::regclass),
  'public.marketplace_awards has RLS enabled'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.marketplace_requests'::regclass),
  'public.marketplace_requests has RLS enabled'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.marketplace_disputes'::regclass),
  'public.marketplace_disputes has RLS enabled'
);

SELECT * FROM finish();

ROLLBACK;
