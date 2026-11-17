-- Migration: Rename legacy log_decision overload to avoid named-arg ambiguity
-- Purpose:
--   - Adding log_decision(..., settings_resolution_id) introduced an overload.
--   - PL/pgSQL named-arg calls become ambiguous when multiple overloads share the same arg names.
--   - Resolve by renaming the legacy 10-arg overload so only the provenance-capable function
--     remains named log_decision.
-- Date: 2025-12-14

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'log_decision'
      AND p.pronargs = 10
  ) THEN
    -- Rename legacy overload (10 args) to avoid ambiguous named-arg resolution.
    ALTER FUNCTION public.log_decision(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB, TEXT)
      RENAME TO log_decision_v1;
  END IF;
END $$;

COMMIT;

