-- Migration: Drop legacy log_decision overload to remove ambiguity
-- Purpose:
--   - Keep a single canonical log_decision() with default settings_resolution_id,
--     so unqualified calls are unambiguous and use accurate timestamps.
-- Alignment: SIMPLE - SSOT.
-- Date: 2025-12-15

BEGIN;

DROP FUNCTION IF EXISTS public.log_decision(
    UUID,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    UUID,
    JSONB,
    TEXT
);

COMMIT;

