-- Plan: PLAN-202603-workflow-studio-runtime-prod-readiness / Step: S04
-- Migration: Add missing workflow runtime request_entry_point lookup values.
-- Rationale:
--   - workflow schedule/manual/trigger/task entry points are emitted by
--     start_workflow_run callers and enforced by workflow_runs.entry_point.
--   - missing lookup rows currently cause ui_run_workflow_schedule_trigger_v1
--     and follow-on workflow chaining to fail with 400s.

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
  false,
  'active'
FROM public.lookup_definitions d
CROSS JOIN (
  VALUES
    ('schedule', 'Schedule', 'Workflow started from the schedule trigger worker', 41),
    ('schedule_manual', 'Schedule Manual', 'Workflow started by manually running a schedule trigger from the UI', 42),
    ('workflow_run_trigger', 'Workflow Run Trigger', 'Workflow started from a workflow_run_triggers chain', 43),
    ('task', 'Task', 'Workflow started from a task-driven workflow action', 44)
) AS v(value, label, description, sort_order)
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  retired_at = NULL,
  effective_from = NULL,
  effective_until = NULL,
  updated_at = now();

DO $assert$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'request_entry_point'
      AND v.value IN ('schedule', 'schedule_manual', 'workflow_run_trigger', 'task')
      AND v.status = 'active'
      AND v.retired_at IS NULL
      AND v.effective_from IS NULL
      AND v.effective_until IS NULL
  ) <> 4 THEN
    RAISE EXCEPTION 'request_entry_point workflow source lookup contract is incomplete';
  END IF;
END;
$assert$;

COMMIT;
