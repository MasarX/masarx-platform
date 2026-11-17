-- Plan: PLAN-202511-comms-prod-ready / S03
-- Purpose: Ensure communications tables have RLS and comms_policy settings are protected.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

-- message_templates RLS/policy
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.message_templates'::regclass),
  'message_templates has RLS enabled'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'message_templates' AND policyname = 'message_templates_service_policy'
  ),
  'message_templates_service_policy exists'
);

-- communications_policy settings protected (settings + settings_versions)
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.settings'::regclass),
  'settings has RLS enabled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.settings_versions'::regclass),
  'settings_versions has RLS enabled'
);
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('settings','settings_versions')
      AND grantee = 'authenticated'
  ),
  0,
  'settings/settings_versions have no grants to authenticated'
);

-- outbound_calls comms policy guard (service_role-only)
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'outbound_calls' AND policyname = 'outbound_calls_service_policy'
  ),
  'outbound_calls_service_policy exists'
);

SELECT * FROM finish();

ROLLBACK;
