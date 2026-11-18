-- pgTAP: Console V2 pickup wave lifecycle lookup.
-- The Pickups waves tab and Add to wave picker consume these live lookup rows
-- for status labels, tones, and row-driven assignability.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'pickup_wave_status'
      AND owner_role = 'operations'
      AND approval_policy = 'tier_1'
      AND is_mutable = false
  ),
  'pickup_wave_status lookup definition exists with operations ownership'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value IN ('planned', 'assigned', 'in_progress', 'completed', 'cancelled')
      AND lv.status = 'active'
  ),
  5,
  'pickup_wave_status has five active lifecycle values'
);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value = 'planned'
  ),
  'Planned',
  'planned status renders with the expected label'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value = 'planned'
  ),
  'neutral',
  'planned status uses the neutral tone'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_assignable'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value = 'planned'
  ),
  'true',
  'planned pickup waves are assignable by row-driven metadata'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value IN ('assigned', 'in_progress', 'completed', 'cancelled')
      AND lv.metadata ->> 'is_assignable' = 'false'
  ),
  4,
  'non-planned pickup waves are not assignable by row-driven metadata'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value = 'assigned'
  ),
  'info',
  'assigned status uses the info tone'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value = 'in_progress'
  ),
  'info',
  'in_progress status uses the info tone'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value = 'completed'
  ),
  'good',
  'completed status uses the good tone'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'pickup_wave_status'
      AND lv.value = 'cancelled'
  ),
  'neutral',
  'cancelled status uses the neutral tone'
);

SELECT * FROM finish();
ROLLBACK;
