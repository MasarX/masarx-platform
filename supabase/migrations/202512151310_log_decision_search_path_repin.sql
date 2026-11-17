-- Migration: Re-pin SECURITY DEFINER search_path for log_decision
-- Purpose:
--   - log_decision is SECURITY DEFINER and must pin search_path to safe schemas.
--   - CREATE OR REPLACE FUNCTION may reset per-function GUCs; enforce the pin
--     after any log_decision body updates.

BEGIN;

ALTER FUNCTION public.log_decision(
    UUID,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    UUID,
    JSONB,
    TEXT,
    UUID
) SET search_path TO public, extensions, pg_temp;

COMMIT;
