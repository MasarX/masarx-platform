-- Migration: Pin search_path for label generation functions and helpers

BEGIN;

ALTER FUNCTION public.request_label_generation(
  UUID, TEXT, UUID, TEXT, UUID, TEXT
) SET search_path TO public, pg_temp;

ALTER FUNCTION public.lease_label_job(
  UUID, INTEGER, UUID
) SET search_path TO public, pg_temp;

ALTER FUNCTION public.complete_label_job(
  UUID, TEXT, TEXT, INTEGER, JSONB, TEXT
) SET search_path TO public, pg_temp;

ALTER FUNCTION public.request_label_reprint(
  UUID, UUID, TEXT
) SET search_path TO public, pg_temp;

COMMIT;

