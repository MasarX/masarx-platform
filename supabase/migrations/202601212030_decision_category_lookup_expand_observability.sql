-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Add missing decision_category values required by observability contracts
-- Purpose:
--   - Keep decision_log validation (lookup_column_contracts) compatible with observability tests and views.
-- Date: 2026-01-21

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status
)
SELECT
  d.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('workflow_handler', 'Workflow Handler', 'Workflow handler execution decisions (observability)', 285),
    ('outbound_dispatch', 'Outbound Dispatch', 'Outbound call dispatch/enqueue decisions (observability)', 145)
) AS v(value, label, description, sort_order)
  ON d.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

