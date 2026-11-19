-- Console V2 import prepare is invoked from the browser through the api schema
-- wrapper. Keep that wrapper aligned with the public prepare timeout contract
-- and avoid doing a full canonical drawer read inside the same prepare RPC.

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := E'    SELECT public.ui_get_tabular_import_run_v1(v_run_id)\n      INTO v_run_preview;\n\n    v_run_summary := COALESCE(v_run_preview->''summary'', ''{}''::jsonb);';
  v_new TEXT := E'    -- tabular_import_prepare_v1.fast_prepare_readback_v1: keep prepare bounded by returning the run row summary here.\n    -- Console performs the canonical backend readback immediately after prepare, so the heavier drawer projection does not belong in this RPC.\n    SELECT jsonb_build_object(\n      ''id'', r.id,\n      ''resource_key'', r.resource_key,\n      ''write_mode'', r.write_mode,\n      ''source_format'', r.source_format,\n      ''source_file_name'', r.source_file_name,\n      ''header_fingerprint'', r.header_fingerprint,\n      ''sheet_name'', r.sheet_name,\n      ''status'', r.status,\n      ''total_rows'', r.total_rows,\n      ''will_create'', r.will_create,\n      ''will_update'', r.will_update,\n      ''will_skip'', r.will_skip,\n      ''blocked_count'', r.blocked_count,\n      ''warning_count'', r.warning_count,\n      ''summary'', COALESCE(r.summary, ''{}''::jsonb),\n      ''rows'', COALESCE(r.summary->''rows_preview'', ''[]''::jsonb)\n    )\n      INTO v_run_preview\n      FROM public.tabular_import_runs r\n     WHERE r.id = v_run_id;\n\n    v_run_summary := COALESCE(v_run_preview->''summary'', ''{}''::jsonb);';
BEGIN
  SELECT pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.tabular_import_prepare_v1(jsonb) is missing';
  END IF;

  IF position('tabular_import_prepare_v1.fast_prepare_readback_v1' IN v_def) = 0 THEN
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not locate canonical prepare readback block in public.tabular_import_prepare_v1';
    END IF;

    v_def := replace(v_def, v_old, v_new);
    EXECUTE v_def;
  END IF;
END;
$do$;

ALTER FUNCTION public.tabular_import_prepare_v1(JSONB)
  SET statement_timeout = '30s';

ALTER FUNCTION api.tabular_import_prepare_v1(JSONB)
  SET statement_timeout = '30s';

COMMENT ON FUNCTION public.tabular_import_prepare_v1(JSONB) IS
  'Prepares a row-driven tabular import run, uses indexed profile matching and lightweight prepare readback, reuses the loaded registry, and has a bounded 30s function-level statement timeout for browser-backed import preparation.';

COMMENT ON FUNCTION api.tabular_import_prepare_v1(JSONB) IS
  'API-schema wrapper for browser-backed tabular import prepare with the same bounded timeout contract as public.tabular_import_prepare_v1.';

COMMIT;
