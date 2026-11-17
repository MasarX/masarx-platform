-- Migration: Geocoding plugin resolver prefers latest entry
-- Purpose:
--   - Ensure matching_plugins overrides take precedence when arrays are appended.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15
BEGIN;

CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_get_plugin(
  p_policy JSONB,
  p_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_plugin JSONB;
BEGIN
  SELECT elem
    INTO v_plugin
    FROM jsonb_array_elements(COALESCE(p_policy->'matching_plugins', '[]'::jsonb))
      WITH ORDINALITY AS t(elem, ord)
   WHERE lower(t.elem->>'name') = lower(p_name)
   ORDER BY ord DESC
   LIMIT 1;

  RETURN v_plugin;
END;
$$;

COMMIT;
