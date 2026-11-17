BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.outbound_calls'::regclass),
    'outbound_calls has RLS enabled'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'outbound_calls'
          AND policyname = 'outbound_calls_service_policy'
    ),
    'outbound_calls_service_policy exists'
);

SELECT ok(
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.comms_attempts'::regclass),
    'comms_attempts has RLS enabled'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'comms_attempts'
          AND policyname = 'comms_attempts_service_policy'
    ),
    'comms_attempts_service_policy exists'
);

SELECT finish();

ROLLBACK;
