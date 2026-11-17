-- Guardrail: decision_category includes workflow_trigger for workflow-run trigger worker logging.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions d
    JOIN public.lookup_values v
      ON v.lookup_definition_id = d.id
    WHERE d.category = 'decision_category'
      AND v.value = 'workflow_trigger'
      AND v.status = 'active'
      AND v.retired_at IS NULL
      AND v.effective_from IS NULL
      AND v.effective_until IS NULL
  ),
  'decision_category includes workflow_trigger'
);

SELECT * FROM finish();

ROLLBACK;
