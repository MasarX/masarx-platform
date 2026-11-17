-- Test: workflow_run_status includes required platform lifecycle values

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'workflow_run_status'
      AND v.value = 'stopped'
      AND v.status = 'active'
  ),
  'workflow_run_status includes stopped'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'workflow_run_status'
      AND v.value = 'continue'
      AND v.status = 'active'
  ),
  'workflow_run_status includes continue'
);

SELECT * FROM finish();

ROLLBACK;
