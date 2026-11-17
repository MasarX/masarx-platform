-- Migration: Webhook edge helper search_path fix
-- Purpose: Ensure edge-facing helpers resolve public schema objects reliably.

BEGIN;

ALTER FUNCTION public.insert_webhook_inbox_record(
    UUID,
    UUID,
    TEXT,
    JSONB,
    JSONB,
    TEXT,
    UUID,
    TEXT
)
    SET search_path TO public, extensions, pg_temp;

ALTER FUNCTION public.get_webhook_source_by_token(TEXT)
    SET search_path TO public, extensions, pg_temp;

COMMIT;
