-- Migration: Pin search_path for request context helper functions

BEGIN;

ALTER FUNCTION public.create_request_context(TEXT, TEXT)
  SET search_path TO public, pg_temp;

ALTER FUNCTION public.complete_request_context(UUID, BOOLEAN, INT)
  SET search_path TO public, pg_temp;

ALTER FUNCTION public.update_cron_config(TEXT)
  SET search_path TO public, pg_temp;

COMMIT;

