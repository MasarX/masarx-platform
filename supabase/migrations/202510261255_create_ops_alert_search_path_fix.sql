-- Migration: Pin search_path for create_ops_alert_for_webhook

BEGIN;

ALTER FUNCTION public.create_ops_alert_for_webhook(
    UUID, UUID, TEXT, JSONB, TEXT
) SET search_path TO public, pg_temp;

COMMIT;

