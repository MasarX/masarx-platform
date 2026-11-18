BEGIN;

SELECT plan(3);

SELECT is(
  (
    SELECT count(*)
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource(value) ON TRUE
    WHERE s.category = 'ui_read_registry'
      AND resource.value->>'key' = 'clients'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
        WHERE filter.value->>'key' = 'name'
          AND filter.value->>'column' = 'name'
          AND lower(COALESCE(filter.value->>'op', '')) = 'ilike'
      )
  ),
  0::bigint,
  'all ui_read_registry settings rows expose clients.name ilike filter'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource(value) ON TRUE
    WHERE s.category = 'ui_read_registry'
      AND resource.value->>'key' = 'senders'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
        WHERE filter.value->>'key' = 'name'
          AND filter.value->>'column' = 'name'
          AND lower(COALESCE(filter.value->>'op', '')) = 'ilike'
      )
  ),
  0::bigint,
  'all ui_read_registry settings rows expose senders.name ilike filter'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource(value) ON TRUE
    WHERE s.category = 'ui_read_registry'
      AND resource.value->>'key' = 'senders'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS filter(value)
        WHERE filter.value->>'key' = 'brand_name'
          AND filter.value->>'column' = 'brand_name'
          AND lower(COALESCE(filter.value->>'op', '')) = 'ilike'
      )
  ),
  0::bigint,
  'all ui_read_registry settings rows expose senders.brand_name ilike filter'
);

SELECT * FROM finish();
ROLLBACK;
