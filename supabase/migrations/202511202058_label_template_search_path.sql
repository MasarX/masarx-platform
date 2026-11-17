-- Migration: Ensure resolve_label_template uses public search path after latest refactors
-- Date: 2025-11-20 20:58 UTC

BEGIN;

ALTER FUNCTION public.resolve_label_template(
    UUID,
    UUID,
    UUID,
    TEXT
)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.lease_label_job(
    UUID,
    INTEGER,
    UUID
)
    SET search_path TO public, pg_temp;

ALTER FUNCTION public.compose_label_payload(
    UUID
)
    SET search_path TO public, pg_temp;

COMMIT;
