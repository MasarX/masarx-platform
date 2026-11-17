-- Test Suite: Mobile attestation table_contracts coverage
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts
    WHERE table_schema = 'public'
      AND table_name = 'mobile_attestation_challenges'
  ),
  'table_contracts row exists for mobile_attestation_challenges'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts
    WHERE table_schema = 'public'
      AND table_name = 'mobile_attestation_events'
  ),
  'table_contracts row exists for mobile_attestation_events'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.table_contracts
    WHERE table_schema = 'public'
      AND table_name IN ('mobile_attestation_challenges', 'mobile_attestation_events')
      AND created_at_required IS DISTINCT FROM TRUE
  ),
  'mobile attestation tables require created_at'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.table_contracts
    WHERE table_schema = 'public'
      AND table_name = 'mobile_attestation_events'
      AND audit_enabled IS FALSE
  ),
  'mobile_attestation_events is audit-disabled by contracts policy'
);

SELECT finish();

ROLLBACK;
