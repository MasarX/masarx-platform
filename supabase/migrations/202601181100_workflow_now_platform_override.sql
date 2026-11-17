-- Migration: Workflow now() override key rename (platform.*)
-- Purpose: Replace legacy session override key `masarx.now_override` with brand-neutral `platform.now_override`.
-- Date: 2026-01-18

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.workflow_now()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
    v_override TEXT;
BEGIN
    BEGIN
        v_override := current_setting('platform.now_override', TRUE);
    EXCEPTION
        WHEN others THEN
            v_override := NULL;
    END;

    IF v_override IS NOT NULL AND trim(v_override) <> '' THEN
        RETURN v_override::timestamptz;
    END IF;

    RETURN now();
END;
$$;

COMMIT;

