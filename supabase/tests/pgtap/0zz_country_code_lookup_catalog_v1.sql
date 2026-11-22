-- Test: country_code lookup catalog stays comprehensive and user-friendly

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'country_code'
  ),
  'country_code lookup category exists'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'country_code'
      AND lv.status = 'active'
  ),
  249,
  'country_code lookup seeds the full active ISO alpha-2 catalog'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'country_code'
      AND lv.status = 'active'
      AND lv.is_default = TRUE
      AND lv.value = 'SA'
  ),
  1,
  'country_code keeps Saudi Arabia as the single default'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'country_code'
      AND lv.status = 'active'
      AND (
        NULLIF(btrim(COALESCE(lv.label, '')), '') IS NULL
        OR btrim(lv.label) = btrim(lv.value)
      )
  ),
  0,
  'country_code active rows expose friendly labels instead of raw codes'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'country_code'
      AND lv.status = 'active'
      AND lv.value = 'AE'
      AND lv.label = 'United Arab Emirates'
  ),
  'country_code includes United Arab Emirates with a friendly label'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'country_code'
      AND lv.status = 'active'
      AND lv.value = 'QA'
      AND lv.label = 'Qatar'
  ),
  'country_code includes Qatar with a friendly label'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'country_code'
      AND lv.status = 'active'
      AND lv.value = 'SA'
      AND lv.label = 'Saudi Arabia'
  ),
  'country_code includes Saudi Arabia with a friendly label'
);

SELECT * FROM finish();

ROLLBACK;
