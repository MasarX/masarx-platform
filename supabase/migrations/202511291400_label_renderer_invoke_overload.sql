-- Migration: Label renderer invoke overload for pgTAP
-- Purpose:
--   - Provide a backwards-compatible invoke_label_renderer(p_max_jobs INT)
--     helper that delegates to the new (INT, JSONB) signature so pgTAP
--     can assert helper presence without coupling to payload shape.

BEGIN;

CREATE OR REPLACE FUNCTION invoke_label_renderer(p_max_jobs INT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
BEGIN
  -- Delegate to the primary implementation with NULL payload. This preserves
  -- existing behaviour for callers that only provide max_jobs while allowing
  -- richer payloads via the extended signature.
  RETURN invoke_label_renderer(p_max_jobs, NULL::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION invoke_label_renderer(INT) TO service_role;
GRANT EXECUTE ON FUNCTION invoke_label_renderer(INT) TO authenticated;

COMMIT;

