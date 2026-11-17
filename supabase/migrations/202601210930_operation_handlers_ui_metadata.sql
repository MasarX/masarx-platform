-- Migration: Operation handlers UI metadata
-- Purpose: Add UI-facing metadata + inspector schema references for workflow studio plugin UX.
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

BEGIN;
SELECT pg_advisory_lock(hashtext('202601210930_operation_handlers_ui_metadata'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.operation_handlers
    ADD COLUMN IF NOT EXISTS ui_label TEXT,
    ADD COLUMN IF NOT EXISTS ui_category TEXT,
    ADD COLUMN IF NOT EXISTS ui_description TEXT,
    ADD COLUMN IF NOT EXISTS config_schema_category TEXT;

COMMENT ON COLUMN public.operation_handlers.ui_label
  IS 'Human-friendly label for workflow studio operation library.';
COMMENT ON COLUMN public.operation_handlers.ui_category
  IS 'Grouping key for workflow studio (e.g., Communications, Labels).';
COMMENT ON COLUMN public.operation_handlers.ui_description
  IS 'Short UI description for operation library cards.';
COMMENT ON COLUMN public.operation_handlers.config_schema_category
  IS 'schema_registry.category used to validate inspector metadata for steps using this handler (active version).';

ALTER TABLE public.operation_handlers
  ALTER COLUMN config_schema_category SET DEFAULT 'workflow_template_step_metadata';

UPDATE public.operation_handlers
   SET config_schema_category = 'workflow_template_step_metadata'
 WHERE config_schema_category IS NULL;

SELECT pg_advisory_unlock(hashtext('202601210930_operation_handlers_ui_metadata'));
COMMIT;
