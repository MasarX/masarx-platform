-- Plan: PLAN-202511-logs-hardening / Steps S02-S03
-- Purpose: Verify RLS + service_role policy coverage for log/observability tables and partitions.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

-- decision_log
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.decision_log'::regclass),
  'decision_log has RLS enabled'
);
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.decision_log'::regclass
      AND c.relrowsecurity = false
  ),
  0,
  'decision_log partitions have RLS enabled'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_log'
      AND policyname = 'decision_log_service_policy'
  ),
  'decision_log_service_policy exists'
);

-- webhook_log
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.webhook_log'::regclass),
  'webhook_log has RLS enabled'
);
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.webhook_log'::regclass
      AND c.relrowsecurity = false
  ),
  0,
  'webhook_log partitions have RLS enabled'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'webhook_log'
      AND policyname = 'webhook_log_service_policy'
  ),
  'webhook_log_service_policy exists'
);

-- api_call_log
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.api_call_log'::regclass),
  'api_call_log has RLS enabled'
);
SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.api_call_log'::regclass
      AND c.relrowsecurity = false
  ),
  0,
  'api_call_log partitions have RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'api_call_log'
      AND policyname = 'api_call_log_service_policy'
  ),
  'api_call_log_service_policy exists'
);

SELECT * FROM finish();

ROLLBACK;
