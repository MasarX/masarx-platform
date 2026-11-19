BEGIN;

SELECT pg_advisory_lock(hashtext('202605120900_tabular_import_run_status_metadata_v1'));

WITH status_metadata(value, metadata) AS (
  VALUES
    ('prepared', '{"is_active": true, "is_terminal": false, "is_cancellable": true}'::jsonb),
    ('queued', '{"is_active": true, "is_terminal": false, "is_cancellable": true}'::jsonb),
    ('processing', '{"is_active": true, "is_terminal": false, "is_cancellable": true}'::jsonb),
    ('completed', '{"is_active": false, "is_terminal": true, "is_cancellable": false}'::jsonb),
    ('completed_with_errors', '{"is_active": false, "is_terminal": true, "is_cancellable": false}'::jsonb),
    ('failed', '{"is_active": false, "is_terminal": true, "is_cancellable": false}'::jsonb),
    ('canceled', '{"is_active": false, "is_terminal": true, "is_cancellable": false}'::jsonb)
)
UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || status_metadata.metadata,
       updated_at = now()
  FROM public.lookup_definitions ld,
       status_metadata
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'tabular_import_run_status'
   AND lv.value = status_metadata.value;

SELECT pg_advisory_unlock(hashtext('202605120900_tabular_import_run_status_metadata_v1'));

COMMIT;
