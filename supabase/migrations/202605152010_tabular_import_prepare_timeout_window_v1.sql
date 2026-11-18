-- Console V2 file imports prepare shipment rows through the tabular import
-- wrapper, which can legitimately exceed the shared edge DB statement timeout
-- while resolving mapping profiles and related-node contracts. Keep the action
-- bounded, but give the importer enough room to return operator-visible
-- diagnostics instead of a generic timeout.

DO $do$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.tabular_import_prepare_v1(jsonb) is missing';
  END IF;

  IF position('tabular_import_prepare_v1.timeout_window_v1' IN v_def) > 0 THEN
    RETURN;
  END IF;

  v_def := replace(
    v_def,
    E'BEGIN\n  IF jsonb_typeof(v_candidate_rules) = ''array''',
    E'BEGIN\n  -- tabular_import_prepare_v1.timeout_window_v1: keep browser-backed import preparation bounded but above the shared edge timeout.\n  PERFORM set_config(''statement_timeout'', ''30000'', true);\n\n  IF jsonb_typeof(v_candidate_rules) = ''array'''
  );

  IF position('tabular_import_prepare_v1.timeout_window_v1' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Could not patch public.tabular_import_prepare_v1 timeout window';
  END IF;

  EXECUTE v_def;
END;
$do$;

COMMENT ON FUNCTION public.tabular_import_prepare_v1(JSONB) IS
  'Prepares a row-driven tabular import run, resolves mapping profiles and related-node contracts, and uses a bounded 30s statement timeout for browser-backed import preparation.';
