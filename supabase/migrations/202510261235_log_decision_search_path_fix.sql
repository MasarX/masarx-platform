-- Migration: Pin search_path for log_decision helper

BEGIN;

ALTER FUNCTION public.log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT)
  SET search_path TO public, pg_temp;

COMMIT;

