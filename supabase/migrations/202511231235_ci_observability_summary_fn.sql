-- Migration: ci_observability_summary() wrapper function
-- Purpose: Provide a PostgREST/RPC-friendly JSON interface over ci_observability_summary_v
-- Date: 2025-11-23

BEGIN;

SET search_path TO public;

CREATE OR REPLACE FUNCTION ci_observability_summary()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT to_jsonb(v)
  FROM ci_observability_summary_v v
$$;

COMMENT ON FUNCTION ci_observability_summary() IS 'Returns a single-row JSON summary of engine/observability metrics for CI.';

GRANT EXECUTE ON FUNCTION ci_observability_summary() TO authenticated, service_role;

COMMIT;

