-- Plan: PLAN-202511-comms-hardening / Steps S02-S03
-- Purpose: Verify communications configuration tables have RLS and service_role policy.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

-- message_templates
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
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'message_templates' AND grantee = 'authenticated'
  ),
  0,
  'message_templates has no grants to authenticated'
);

-- recipient_preferences
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.recipient_preferences'::regclass),
  'recipient_preferences has RLS enabled'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'recipient_preferences' AND policyname = 'recipient_preferences_service_policy'
  ),
  'recipient_preferences_service_policy exists'
);
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'recipient_preferences' AND grantee = 'authenticated'
  ),
  0,
  'recipient_preferences has no grants to authenticated'
);

-- provider_usage_tracking
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_usage_tracking'::regclass),
  'provider_usage_tracking has RLS enabled'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'provider_usage_tracking' AND policyname = 'provider_usage_tracking_service_policy'
  ),
  'provider_usage_tracking_service_policy exists'
);
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'provider_usage_tracking' AND grantee = 'authenticated'
  ),
  0,
  'provider_usage_tracking has no grants to authenticated'
);

SELECT * FROM finish();

ROLLBACK;
