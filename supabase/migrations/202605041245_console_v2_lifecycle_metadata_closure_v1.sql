-- Migration: Console V2 lifecycle metadata closure v1
-- Purpose:
--   - Keep import-source UI behavior row-driven by adding requires_prepared_file
--     metadata to canonical lookup rows.
--   - Preserve the existing lookup labels/order/defaults while adding the
--     metadata Console V2 uses to choose direct-submit versus prepared-file flow.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605041245_console_v2_lifecycle_metadata_closure_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH desired AS (
  SELECT *
  FROM (VALUES
    ('file_upload'::text, TRUE),
    ('api'::text, FALSE),
    ('manual'::text, FALSE)
  ) AS v(value, requires_prepared_file)
)
UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
  || jsonb_build_object('requires_prepared_file', desired.requires_prepared_file),
    updated_at = now()
FROM public.lookup_definitions ld
JOIN desired
  ON TRUE
WHERE ld.id = lv.lookup_definition_id
  AND ld.category = 'import_job_source'
  AND lv.value = desired.value;

SELECT pg_advisory_unlock(hashtext('202605041245_console_v2_lifecycle_metadata_closure_v1'));
COMMIT;
