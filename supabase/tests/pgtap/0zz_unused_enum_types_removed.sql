-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- pgTAP: Ensure unused legacy ENUM types are removed (zero redundancy).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname IN ('shipment_status', 'service_type', 'priority_level')
  ),
  'Legacy public ENUM types removed (shipment_status, service_type, priority_level)'
);

SELECT * FROM finish();

ROLLBACK;

