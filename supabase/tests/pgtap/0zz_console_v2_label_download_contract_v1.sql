SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

WITH registry AS (
  SELECT public.ui_read_registry_v1() AS value
),
resources AS (
  SELECT resource
    FROM registry,
         jsonb_array_elements(COALESCE(value->'resources', '[]'::jsonb)) AS resource
)
SELECT is(
  (SELECT resource->'download'->>'path_column' FROM resources WHERE resource->>'key' = 'labels'),
  'file_url',
  'labels resource exposes signed download file_url path'
);

WITH registry AS (
  SELECT public.ui_read_registry_v1() AS value
),
resources AS (
  SELECT resource
    FROM registry,
         jsonb_array_elements(COALESCE(value->'resources', '[]'::jsonb)) AS resource
)
SELECT is(
  (SELECT resource->'download'->>'path_column' FROM resources WHERE resource->>'key' = 'label_versions'),
  'file_url',
  'label_versions resource exposes signed download file_url path'
);

WITH registry AS (
  SELECT public.ui_read_registry_v1() AS value
),
resources AS (
  SELECT resource
    FROM registry,
         jsonb_array_elements(COALESCE(value->'resources', '[]'::jsonb)) AS resource
)
SELECT is(
  (SELECT resource->'download'->>'path_column' FROM resources WHERE resource->>'key' = 'label_jobs'),
  'output_file_url',
  'label_jobs resource exposes signed download output_file_url path'
);

WITH registry AS (
  SELECT public.ui_read_registry_v1() AS value
),
resources AS (
  SELECT resource
    FROM registry,
         jsonb_array_elements(COALESCE(value->'resources', '[]'::jsonb)) AS resource
)
SELECT is(
  (SELECT resource->'download'->>'capability' FROM resources WHERE resource->>'key' = 'label_artifacts'),
  'labels.download',
  'label_artifacts resource download is gated by labels.download'
);

WITH required AS (
  SELECT *
    FROM (VALUES
      ('labels', 'file_url'),
      ('label_versions', 'file_url'),
      ('label_jobs', 'output_file_url'),
      ('label_artifacts', 'file_url')
    ) AS r(resource_key, path_column)
),
missing AS (
  SELECT s.id, r.resource_key
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
    CROSS JOIN required r
   WHERE s.category = 'ui_read_registry'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
        WHERE resource->>'key' = r.resource_key
          AND resource->'download'->>'path_column' = r.path_column
          AND resource->'download'->>'capability' = 'labels.download'
     )
)
SELECT is(
  (SELECT count(*) FROM missing),
  0::bigint,
  'all ui_read_registry scope rows expose label signed download settings'
);

SELECT * FROM finish();
ROLLBACK;
