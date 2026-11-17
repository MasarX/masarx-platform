-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Add missing decision_category lookup values used by core workflows (fixup)
-- Rationale:
--   - `decision_log.decision_category` is contract-enforced via lookup_values.
--   - Several core workflows emit categories that must be valid to avoid runtime failures.

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
    ('quote_promise', 'Quote & Promise', 'SLA/quote/promise evaluation decisions', 125),
    ('settlement', 'Settlement', 'Settlement batch creation, transitions, and reconciliation decisions', 135),
    ('task', 'Task', 'Task creation/assignment/transition decisions', 141),
    ('dispatch', 'Dispatch', 'Dispatch planning and assignment decisions', 145),
    ('warehouse', 'Warehouse', 'Warehouse operations decisions', 150)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

