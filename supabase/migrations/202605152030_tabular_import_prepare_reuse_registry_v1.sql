-- Avoid loading the full UI read registry twice during tabular import prepare.
-- The wrapper already materializes v_registry before resolving inline related
-- nodes, so resolve the primary resource from that same JSON payload instead
-- of calling tabular_import_resolve_resource_v1, which loads/enriches the
-- registry again.

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := E'  v_registry := public.ui_read_registry_v1();\n  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);\n  v_node_contracts := public.tabular_import_resolve_inline_node_contracts_v1(v_resource, v_registry);';
  v_new TEXT := E'  v_registry := public.ui_read_registry_v1();\n  -- tabular_import_prepare_v1.reuse_registry_v1: avoid a second full registry enrichment during prepare.\n  SELECT value\n    INTO v_resource\n    FROM jsonb_array_elements(COALESCE(v_registry->''resources'', ''[]''::jsonb)) AS value\n   WHERE value->>''key'' = COALESCE(v_resource_key, '''')\n   LIMIT 1;\n  v_node_contracts := public.tabular_import_resolve_inline_node_contracts_v1(v_resource, v_registry);';
BEGIN
  SELECT pg_get_functiondef('public.tabular_import_prepare_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.tabular_import_prepare_v1(jsonb) is missing';
  END IF;

  IF position('tabular_import_prepare_v1.reuse_registry_v1' IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'Could not locate duplicated registry resolver in public.tabular_import_prepare_v1';
  END IF;

  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END;
$do$;

ALTER FUNCTION public.tabular_import_prepare_v1(JSONB)
  SET statement_timeout = '30s';

COMMENT ON FUNCTION public.tabular_import_prepare_v1(JSONB) IS
  'Prepares a row-driven tabular import run, resolves mapping profiles and related-node contracts, reuses the loaded registry during prepare, and has a bounded 30s function-level statement timeout for browser-backed import preparation.';
