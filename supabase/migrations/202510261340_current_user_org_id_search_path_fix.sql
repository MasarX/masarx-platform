-- Migration: Pin search_path for current_user_org_id

BEGIN;

ALTER FUNCTION public.current_user_org_id()
  SET search_path TO public, pg_temp;

COMMIT;

