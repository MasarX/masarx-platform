SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT is(
  (
    SELECT lv.metadata->>'is_active_zone_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'zone_status'
      AND lv.value = 'active'
  ),
  'true',
  'zone_status.active counts as active'
);

SELECT is(
  (
    SELECT lv.metadata->>'is_suspended_zone_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'zone_status'
      AND lv.value = 'active'
  ),
  'false',
  'zone_status.active does not count as suspended'
);

SELECT is(
  (
    SELECT lv.metadata->>'is_suspended_zone_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'zone_status'
      AND lv.value = 'suspended'
  ),
  'true',
  'zone_status.suspended counts as suspended'
);

SELECT is(
  (
    SELECT lv.metadata->>'is_active_zone_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'zone_status'
      AND lv.value = 'draft'
  ),
  'false',
  'zone_status.draft does not count as active'
);

SELECT is(
  (
    SELECT lv.metadata->>'is_active_zone_status'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'zone_status'
      AND lv.value = 'retired'
  ),
  'false',
  'zone_status.retired does not count as active'
);

SELECT * FROM finish();
ROLLBACK;
