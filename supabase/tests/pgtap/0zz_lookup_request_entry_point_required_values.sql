-- Test: request_entry_point includes required platform wrapper entry points

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'request_entry_point'
      AND v.value = 'label_job_wrapper'
      AND v.status = 'active'
  ),
  'request_entry_point includes label_job_wrapper'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values v
    JOIN public.lookup_definitions d ON d.id = v.lookup_definition_id
    WHERE d.category = 'request_entry_point'
      AND v.value = 'enqueue_outbound_call'
      AND v.status = 'active'
  ),
  'request_entry_point includes enqueue_outbound_call'
);

SELECT * FROM finish();

ROLLBACK;
