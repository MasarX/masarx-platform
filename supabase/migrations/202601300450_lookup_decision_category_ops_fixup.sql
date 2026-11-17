-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Add missing decision_category lookup value `ops` (fixup)
-- Rationale:
--   - Ops session/task workflows emit `decision_log` entries and must use contract-valid categories.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    ('ops', 'Operations', 'Operational session/task orchestration decisions', 140)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

