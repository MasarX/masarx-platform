-- Plan: PLAN-202601-finance-events-ledger-foundation / Step: S04
-- Migration: Add missing decision_category lookup value `finance` (fixup)
-- Rationale:
--   - `decision_log.decision_category` is contract-enforced via lookup_values.
--   - Finance/settlement workflows emit decisions (e.g., bank statement ingest) and must use a valid category.

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
    ('finance', 'Finance', 'Finance, accounting, settlement, and reconciliation decisions', 130)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

