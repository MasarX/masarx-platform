-- pgTAP: Console V2 inbox force-status resolves terminal failure from lookup rows.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'processing_status'
  ),
  'processing_status lookup definition exists'
);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'processing_status'
      AND lv.value = 'failed'
  ),
  'Failed',
  'failed processing status has operator-facing label'
);

SELECT is(
  (
    SELECT lv.metadata->>'is_terminal_failure'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'processing_status'
      AND lv.value = 'failed'
  ),
  'true',
  'failed processing status is marked as the terminal failure target'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'processing_status'
      AND lv.metadata->>'is_terminal_failure' = 'true'
      AND lv.status = 'active'
  ),
  1,
  'processing_status exposes exactly one active terminal failure row'
);

SELECT * FROM finish();

ROLLBACK;
