-- Migration: Pin search_path for JSON mapping helpers

BEGIN;

ALTER FUNCTION public.safe_jsonpath_query_first(JSONB, TEXT)
  SET search_path TO public, pg_temp;

ALTER FUNCTION public.apply_request_mappings(JSONB, JSONB, JSONB)
  SET search_path TO public, pg_temp;

COMMIT;

