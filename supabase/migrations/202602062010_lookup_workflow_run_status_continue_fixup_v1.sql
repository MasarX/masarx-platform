-- Plan: PLAN-202602-fieldops-mobile-app-prod-completion / Step: S99
-- Migration: Drift repair - workflow_run_status include continue (v1)
-- Purpose:
--   - Reassert internal workflow engine transitional status used by progress_workflow_run responses.
--   - Keep lookup contract idempotent for reused preview databases.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'continue', 'Continue', 25, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'workflow_run_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active';

COMMIT;
