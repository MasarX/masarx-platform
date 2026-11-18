-- Console V2 manual shipment service offering projection contract.
-- First-tenant onboarding provisions Same-day delivery as service_levels.key
-- `same_day`; shipments.service_level lookup governance must allow that
-- backend-projected value.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions
     WHERE category = 'service_level'
       AND description ILIKE '%same_day%'
  ),
  'service_level lookup definition documents same_day as a governed shipment service level'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'service_level'
       AND lv.value = 'same_day'
       AND lv.status = 'active'
       AND lv.retired_at IS NULL
  ),
  'service_level lookup allows same_day for Same-day service offerings'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'service_level'
       AND lv.value = 'white_glove'
       AND lv.status = 'active'
       AND lv.retired_at IS NULL
  ),
  'service_level lookup allows white_glove for catalog parity with service level tiers'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.service_levels sl
     WHERE sl.key IN ('same_day', 'white_glove')
       AND NOT EXISTS (
         SELECT 1
           FROM public.lookup_values lv
           JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
          WHERE ld.category = 'service_level'
            AND lv.value = sl.key
            AND lv.status = 'active'
            AND lv.retired_at IS NULL
       )
  ),
  'active service_levels used by Console service offerings cannot drift beyond shipments.service_level lookup governance'
);

SELECT * FROM finish();

ROLLBACK;
