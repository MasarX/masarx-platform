-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Add missing request_entry_point lookup value `domain_event` (fixup)
-- Rationale:
--   - `workflow_runs.entry_point` is contract-enforced via lookup_values (category=request_entry_point).
--   - domain_events_worker starts workflow runs with trigger_source=domain_event, which sets entry_point=domain_event.

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
    ('domain_event', 'Domain Event', 'Workflow started from domain_events worker dispatch', 40)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

