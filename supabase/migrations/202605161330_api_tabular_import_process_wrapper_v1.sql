BEGIN;

CREATE OR REPLACE FUNCTION api.process_tabular_import_run_v1(
  p_run_id UUID,
  p_batch_size INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.process_tabular_import_run_v1($1, $2);
$$;

COMMENT ON FUNCTION api.process_tabular_import_run_v1(UUID, INTEGER) IS
  'API-schema service wrapper for resource-import-studio to process a started tabular import through the canonical backend processor.';

REVOKE ALL ON FUNCTION api.process_tabular_import_run_v1(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.process_tabular_import_run_v1(UUID, INTEGER) TO service_role;

COMMIT;
