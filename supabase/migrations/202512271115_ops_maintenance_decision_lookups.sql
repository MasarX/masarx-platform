-- Plan: PLAN-202512-ops-maintenance-universal / Step: S04
-- Migration: Ops maintenance decision lookup values
-- Purpose: Add decision_category/decision_outcome entries for ops maintenance decisions.
-- Date: 2025-12-27

BEGIN;

-- decision_category: ops_maintenance
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false
FROM lookup_definitions ld
CROSS JOIN (VALUES
  ('ops_maintenance', 'Ops Maintenance', 'Maintenance worker decisions (retry/quarantine)', 130)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- decision_outcome: retry_scheduled, quarantined
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false
FROM lookup_definitions ld
CROSS JOIN (VALUES
  ('retry_scheduled', 'Retry Scheduled', 'Maintenance scheduled a retry for the resource', 110),
  ('quarantined', 'Quarantined', 'Resource moved to ops_quarantine for manual review', 120)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_outcome'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;
