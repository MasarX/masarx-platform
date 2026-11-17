-- Plan: PLAN-202603-workflow-studio-runtime-prod-readiness / Step: S04
-- Migration: Register workflow_trigger decision_category for workflow_run_triggers_worker
-- Why:
--   - public.run_workflow_run_triggers_worker() logs decision_log rows with
--     decision_category='workflow_trigger'.
--   - decision_log.decision_category is lookup-enforced, so the worker fails
--     until the category exists in public.lookup_values.

BEGIN;

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
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false,
  'active'
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    (
      'workflow_trigger',
      'Workflow Trigger',
      'Workflow-to-workflow trigger orchestration decisions',
      140
    )
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
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
  IF NOT EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'decision_category'
      AND v.value = 'workflow_trigger'
      AND v.status = 'active'
      AND v.retired_at IS NULL
      AND v.effective_from IS NULL
      AND v.effective_until IS NULL
  ) THEN
    RAISE EXCEPTION 'decision_category workflow_trigger lookup contract is incomplete';
  END IF;
END;
$assert$;

COMMIT;
