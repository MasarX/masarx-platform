-- Migration: Operation handlers UI defaults
-- Purpose: Provide sane, row-driven defaults for workflow studio operation palette metadata.
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

BEGIN;
SELECT pg_advisory_lock(hashtext('202601211600_operation_handlers_ui_defaults'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.operation_handlers_ui_defaults_v1(p_handler_key TEXT, p_notes TEXT)
RETURNS TABLE (
  ui_label TEXT,
  ui_category TEXT,
  ui_description TEXT
)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    initcap(replace(p_handler_key, '_', ' ')) AS ui_label,
    initcap(split_part(p_handler_key, '_', 1)) AS ui_category,
    NULLIF(regexp_replace(trim(COALESCE(p_notes, '')), '\s+', ' ', 'g'), '') AS ui_description;
$$;

-- Backfill existing rows (do not override explicitly-configured values).
UPDATE public.operation_handlers oh
SET
  ui_label = COALESCE(oh.ui_label, d.ui_label),
  ui_category = COALESCE(oh.ui_category, d.ui_category),
  ui_description = COALESCE(oh.ui_description, d.ui_description)
FROM (
  SELECT
    oh2.handler_key,
    d2.ui_label,
    d2.ui_category,
    d2.ui_description
  FROM public.operation_handlers AS oh2
  CROSS JOIN LATERAL public.operation_handlers_ui_defaults_v1(oh2.handler_key, oh2.notes) AS d2
) AS d
WHERE
  d.handler_key = oh.handler_key
  AND (
    oh.ui_label IS NULL
    OR oh.ui_category IS NULL
    OR oh.ui_description IS NULL
  );

-- Canonical naming overrides for base handlers (keep overrides non-destructive).
UPDATE public.operation_handlers
SET
  ui_label = 'Outbound HTTP',
  ui_category = 'HTTP'
WHERE
  handler_key = 'outbound_http'
  AND ui_label = initcap(replace(handler_key, '_', ' '))
  AND ui_category = initcap(split_part(handler_key, '_', 1));

UPDATE public.operation_handlers
SET
  ui_category = 'Labels'
WHERE
  handler_key = 'label_job'
  AND ui_category = initcap(split_part(handler_key, '_', 1));

CREATE OR REPLACE FUNCTION public.operation_handlers_set_ui_defaults_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_ui_label TEXT;
  v_ui_category TEXT;
  v_ui_description TEXT;
BEGIN
  IF NEW.ui_label IS NOT NULL AND NEW.ui_category IS NOT NULL AND NEW.ui_description IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.ui_label, d.ui_category, d.ui_description
    INTO v_ui_label, v_ui_category, v_ui_description
    FROM public.operation_handlers_ui_defaults_v1(NEW.handler_key, NEW.notes) AS d;

  NEW.ui_label := COALESCE(NEW.ui_label, v_ui_label);
  NEW.ui_category := COALESCE(NEW.ui_category, v_ui_category);
  NEW.ui_description := COALESCE(NEW.ui_description, v_ui_description);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operation_handlers_set_ui_defaults ON public.operation_handlers;
CREATE TRIGGER operation_handlers_set_ui_defaults
  BEFORE INSERT ON public.operation_handlers
  FOR EACH ROW
  EXECUTE FUNCTION public.operation_handlers_set_ui_defaults_v1();

SELECT pg_advisory_unlock(hashtext('202601211600_operation_handlers_ui_defaults'));
COMMIT;
