-- Plan: PLAN-202512-comms-prod-ready-p0p2 / Reply state tables RLS
-- Purpose: Verify comms reply state tables have RLS and service_role policy.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

-- comms_reply_sessions
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.comms_reply_sessions'::regclass),
  'comms_reply_sessions has RLS enabled'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'comms_reply_sessions' AND policyname = 'comms_reply_sessions_service_policy'
  ),
  'comms_reply_sessions_service_policy exists'
);
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'comms_reply_sessions' AND grantee = 'authenticated'
  ),
  0,
  'comms_reply_sessions has no grants to authenticated'
);

-- comms_reply_rate_limits
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.comms_reply_rate_limits'::regclass),
  'comms_reply_rate_limits has RLS enabled'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'comms_reply_rate_limits' AND policyname = 'comms_reply_rate_limits_service_policy'
  ),
  'comms_reply_rate_limits_service_policy exists'
);
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'comms_reply_rate_limits' AND grantee = 'authenticated'
  ),
  0,
  'comms_reply_rate_limits has no grants to authenticated'
);

SELECT * FROM finish();

ROLLBACK;

