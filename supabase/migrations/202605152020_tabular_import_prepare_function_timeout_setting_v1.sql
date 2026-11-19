-- Apply the import prepare timeout before the function body starts. An inline
-- set_config happens too late for the current RPC statement timeout.

ALTER FUNCTION public.tabular_import_prepare_v1(JSONB)
  SET statement_timeout = '30s';

COMMENT ON FUNCTION public.tabular_import_prepare_v1(JSONB) IS
  'Prepares a row-driven tabular import run, resolves mapping profiles and related-node contracts, and has a bounded 30s function-level statement timeout for browser-backed import preparation.';
