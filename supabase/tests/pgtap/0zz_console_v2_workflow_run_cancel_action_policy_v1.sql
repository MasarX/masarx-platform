BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT is(
  (
    SELECT lv.metadata->>'allows_abort'
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_run_status'
       AND lv.value = 'in_progress'
     LIMIT 1
  ),
  'true',
  'workflow_run_status in_progress allows cancel action'
);

SELECT is(
  (
    SELECT lv.metadata->>'allows_abort'
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_run_status'
       AND lv.value = 'pending'
     LIMIT 1
  ),
  'true',
  'workflow_run_status pending allows cancel action'
);

SELECT is(
  (
    SELECT lv.metadata->>'allows_abort'
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_run_status'
       AND lv.value = 'failed'
     LIMIT 1
  ),
  'false',
  'workflow_run_status failed is retry-only, not cancelable'
);

SELECT is(
  (
    SELECT lv.metadata->>'allows_abort'
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_run_status'
       AND lv.value = 'cancelled'
     LIMIT 1
  ),
  'false',
  'workflow_run_status cancelled is terminal and not cancelable'
);

SELECT is(
  (
    SELECT lv.metadata->>'allows_abort'
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'workflow_run_status'
       AND lv.value = 'completed'
     LIMIT 1
  ),
  'false',
  'workflow_run_status completed is terminal and not cancelable'
);

SELECT * FROM finish();

ROLLBACK;
