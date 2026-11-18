-- pgTAP: Console V2 client lifecycle actions must stay lookup-metadata driven.

BEGIN;

SELECT plan(4);

SELECT is(
  (
    SELECT lv.metadata->>'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'client_status'
      AND lv.value = 'active'
    LIMIT 1
  ),
  'active',
  'client_status.active carries active lifecycle metadata'
);

SELECT is(
  (
    SELECT lv.metadata->>'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'client_status'
      AND lv.value = 'suspended'
    LIMIT 1
  ),
  'suspended',
  'client_status.suspended carries suspended lifecycle metadata'
);

SELECT is(
  (
    SELECT lv.metadata->>'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'client_status'
      AND lv.value = 'terminated'
    LIMIT 1
  ),
  'terminal',
  'client_status.terminated carries terminal lifecycle metadata'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'client_status'
      AND lv.value IN ('active', 'suspended', 'terminated')
      AND COALESCE(lv.metadata->>'lifecycle', '') = ''
  ),
  'all required client_status rows expose lifecycle metadata'
);

SELECT * FROM finish();

ROLLBACK;
