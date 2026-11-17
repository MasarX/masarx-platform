-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose: add missing decision_category lookup value for workflow_binding dispatcher audit events.

BEGIN;
SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'workflow_binding', 'Workflow Binding', 235, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active';

COMMIT;
