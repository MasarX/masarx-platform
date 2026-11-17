-- Test: request_entry_point includes workflow runtime trigger sources

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'request_entry_point'
      AND v.value = 'schedule'
      AND v.status = 'active'
      AND v.retired_at IS NULL
      AND v.effective_from IS NULL
      AND v.effective_until IS NULL
  ),
  'request_entry_point includes schedule'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'request_entry_point'
      AND v.value = 'schedule_manual'
      AND v.status = 'active'
      AND v.retired_at IS NULL
      AND v.effective_from IS NULL
      AND v.effective_until IS NULL
  ),
  'request_entry_point includes schedule_manual'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'request_entry_point'
      AND v.value = 'workflow_run_trigger'
      AND v.status = 'active'
      AND v.retired_at IS NULL
      AND v.effective_from IS NULL
      AND v.effective_until IS NULL
  ),
  'request_entry_point includes workflow_run_trigger'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'request_entry_point'
      AND v.value = 'task'
      AND v.status = 'active'
      AND v.retired_at IS NULL
      AND v.effective_from IS NULL
      AND v.effective_until IS NULL
  ),
  'request_entry_point includes task'
);

SELECT * FROM finish();

ROLLBACK;
