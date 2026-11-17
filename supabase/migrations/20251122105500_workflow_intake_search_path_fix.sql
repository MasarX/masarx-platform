-- Migration: Ensure workflow_intake_webhook search_path includes extensions
-- Date: 2025-11-22 10:55 UTC

BEGIN;

ALTER FUNCTION public.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)
    SET search_path TO public, extensions, pg_temp;

COMMIT;
