-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose:
-- - Align public_tracking_policy schema validation with the hardened runtime
--   fallback that no longer requires notifications.task.organization_slug.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
SET
  schema = jsonb_set(
    schema,
    '{properties,notifications,properties,task,required}',
    '["task_type_key","priority","sla_minutes"]'::jsonb,
    TRUE
  ),
  examples = CASE
    WHEN jsonb_typeof(examples) = 'array' THEN (
      SELECT jsonb_agg(
        CASE
          WHEN jsonb_typeof(example_item) = 'object' THEN example_item #- '{notifications,task,organization_slug}'
          ELSE example_item
        END
      )
      FROM jsonb_array_elements(examples) AS example_item
    )
    ELSE examples
  END,
  updated_at = workflow_now()
WHERE category = 'public_tracking_policy'
  AND version = 1;

COMMIT;
