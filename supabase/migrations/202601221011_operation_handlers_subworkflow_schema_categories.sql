-- Migration: Operation handler schema categories for subworkflow handlers
-- Purpose: Point start_workflow/wait_workflow to handler-specific schema_registry categories so
--          Workflow Studio can render validated, schema-driven editors.
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221011_operation_handlers_subworkflow_schema_categories'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.operation_handlers
SET
  config_schema_category = 'workflow_step_start_workflow_metadata',
  ui_category = COALESCE(ui_category, 'Workflow'),
  ui_label = COALESCE(ui_label, 'Start workflow'),
  ui_description = COALESCE(ui_description, 'Launch a child workflow run.'),
  updated_at = now()
WHERE handler_key = 'start_workflow'
  AND (
    config_schema_category IS NULL
    OR config_schema_category = 'workflow_template_step_metadata'
  );

UPDATE public.operation_handlers
SET
  config_schema_category = 'workflow_step_wait_workflow_metadata',
  ui_category = COALESCE(ui_category, 'Workflow'),
  ui_label = COALESCE(ui_label, 'Wait workflow'),
  ui_description = COALESCE(ui_description, 'Wait for a child workflow run to finish.'),
  updated_at = now()
WHERE handler_key = 'wait_workflow'
  AND (
    config_schema_category IS NULL
    OR config_schema_category = 'workflow_template_step_metadata'
  );

SELECT pg_advisory_unlock(hashtext('202601221011_operation_handlers_subworkflow_schema_categories'));
COMMIT;

