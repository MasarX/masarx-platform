-- Migration: Pin search_path for resolve_label_template to ensure relation visibility

BEGIN;

ALTER FUNCTION public.resolve_label_template(UUID, UUID, UUID, TEXT)
  SET search_path TO public, pg_temp;

COMMIT;

