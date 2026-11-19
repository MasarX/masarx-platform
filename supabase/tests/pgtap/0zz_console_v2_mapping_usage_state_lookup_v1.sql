-- pgTAP: Console V2 Mapping studio usage-state labels stay row-driven.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'mapping_usage_state'
  ),
  'mapping_usage_state lookup definition exists'
);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'mapping_usage_state'
      AND lv.value = 'unused'
  ),
  'Unused',
  'unused usage state has operator-facing label'
);

SELECT is(
  (
    SELECT lv.metadata->>'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'mapping_usage_state'
      AND lv.value = 'unused'
  ),
  'neutral',
  'unused usage state has neutral chip tone'
);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'mapping_usage_state'
      AND lv.value = 'in_use'
  ),
  'In use',
  'in_use usage state has operator-facing label'
);

SELECT is(
  (
    SELECT lv.metadata->>'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'mapping_usage_state'
      AND lv.value = 'in_use'
  ),
  'good',
  'in_use usage state has good chip tone'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'mapping_usage_state'
      AND lv.status = 'active'
      AND lv.value IN ('unused', 'in_use')
  ),
  2,
  'mapping_usage_state exposes the two active usage states used by Console V2'
);

SELECT * FROM finish();

ROLLBACK;
