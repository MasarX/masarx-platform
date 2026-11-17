-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: Drift repair - lookup workflow_run_status=stopped (v1)
-- Purpose:
--   - Reassert internal lookup_values required by verify:cloud integration tests in reused preview DBs:
--       * workflow_run_status: stopped
--   - Append-only and idempotent (ON CONFLICT DO NOTHING).

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- workflow_run_status: support opt-out stop semantics and workflow_mark_run_stopped contract.
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'stopped', 'Stopped', 35, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'workflow_run_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;
