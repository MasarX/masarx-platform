-- Migration: Pin search_path for compose_label_payload to resolve label_jobs and views

BEGIN;

ALTER FUNCTION public.compose_label_payload(UUID)
  SET search_path TO public, pg_temp;

COMMIT;

