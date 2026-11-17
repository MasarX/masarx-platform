-- Migration: Fix __label_try_numeric for publish gate validation
-- Purpose: Replace regex-based numeric parsing (POSIX) with safe cast-based parsing.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION public.__label_try_numeric(p_text TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN p_text::numeric;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$;

COMMENT ON FUNCTION public.__label_try_numeric(TEXT) IS
'Internal helper: best-effort numeric parse used by label template validation (returns NULL when not numeric).';

-- Revalidate existing templates now that parsing is correct.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, organization_id
    FROM label_template_specs
  LOOP
    PERFORM public.validate_label_template(r.id, r.organization_id, NULL);
  END LOOP;
END;
$$;

COMMIT;

