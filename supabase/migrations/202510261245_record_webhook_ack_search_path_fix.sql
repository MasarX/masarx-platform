-- Migration: Pin search_path for record_webhook_ack to ensure table qualification

BEGIN;

ALTER FUNCTION public.record_webhook_ack(
    UUID, UUID, TEXT, INT, UUID, TEXT, UUID, INT, JSONB, JSONB, TEXT, TEXT, JSONB, TIMESTAMPTZ, TEXT, JSONB, UUID
) SET search_path TO public, pg_temp;

COMMIT;

