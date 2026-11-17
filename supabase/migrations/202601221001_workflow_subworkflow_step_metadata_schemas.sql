-- Migration: Workflow subworkflow step metadata schemas
-- Purpose: Provide schema_registry contracts for start_workflow/wait_workflow step metadata,
--          enabling schema-driven editing and validation in Workflow Studio.
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

BEGIN;
SELECT pg_advisory_lock(hashtext('202601221001_workflow_subworkflow_step_metadata_schemas'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) start_workflow step metadata (extends workflow_template_step_metadata)
-- ---------------------------------------------------------------------------

INSERT INTO public.schema_registry AS sr (
  id,
  category,
  version,
  schema,
  description,
  examples,
  is_active,
  created_at
)
VALUES (
  'aaaa0000-0000-0000-0000-000000000703',
  'workflow_step_start_workflow_metadata',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Start workflow step metadata",
    "type": "object",
    "additionalProperties": true,
    "x-masarx": { "extends": "workflow_template_step_metadata" },
    "properties": {
      "child_workflow_template_id": {
        "title": "Child workflow template",
        "type": "string",
        "format": "uuid",
        "x-ui": {
          "widget": "resource_select",
          "resource": "workflow_templates",
          "label_column": "name",
          "filters": { "status": "active" }
        }
      },
      "workflow_template_id": {
        "title": "Workflow template (legacy)",
        "type": "string",
        "format": "uuid"
      },
      "context_patch": {
        "title": "Context patch",
        "type": "object",
        "additionalProperties": true,
        "description": "Merged into the child workflow run context before launch."
      }
    },
    "anyOf": [
      { "required": ["child_workflow_template_id"] },
      { "required": ["workflow_template_id"] }
    ]
  }'::jsonb,
  'Handler-specific metadata contract for start_workflow (launch child workflow run).',
  '[
    {
      "child_workflow_template_id": "11110000-0000-0000-0000-000000000001",
      "context_patch": { "from_parent": true }
    }
  ]'::jsonb,
  TRUE,
  workflow_now()
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  created_at = workflow_now();

-- ---------------------------------------------------------------------------
-- 2) wait_workflow step metadata (extends workflow_template_step_metadata)
-- ---------------------------------------------------------------------------

INSERT INTO public.schema_registry AS sr (
  id,
  category,
  version,
  schema,
  description,
  examples,
  is_active,
  created_at
)
VALUES (
  'aaaa0000-0000-0000-0000-000000000704',
  'workflow_step_wait_workflow_metadata',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Wait workflow step metadata",
    "type": "object",
    "additionalProperties": true,
    "x-masarx": { "extends": "workflow_template_step_metadata" },
    "properties": {
      "child_workflow_run_id": {
        "title": "Child workflow run id",
        "type": "string",
        "format": "uuid"
      },
      "poll_interval_seconds": {
        "title": "Poll interval (seconds)",
        "type": "integer",
        "minimum": 5
      },
      "max_wait_seconds": {
        "title": "Max wait (seconds)",
        "type": "integer",
        "minimum": 1
      }
    }
  }'::jsonb,
  'Handler-specific metadata contract for wait_workflow (poll child workflow run until completion/failure/timeout).',
  '[
    {
      "poll_interval_seconds": 30,
      "max_wait_seconds": 900
    }
  ]'::jsonb,
  TRUE,
  workflow_now()
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  created_at = workflow_now();

-- ---------------------------------------------------------------------------
-- 3) Non-breaking UI hints for base workflow_template_step_metadata
--    (x-ui widgets are ignored by validator; used by the frontend renderer)
-- ---------------------------------------------------------------------------

UPDATE public.schema_registry
SET
  schema = jsonb_set(
    schema,
    '{properties,operation_template_id}',
    jsonb_build_object(
      'title',
      'Operation template',
      'type',
      'string',
      'format',
      'uuid',
      'x-ui',
      jsonb_build_object(
        'widget',
        'resource_select',
        'resource',
        'operation_templates',
        'label_column',
        'name'
      )
    ),
    true
  ),
  created_at = workflow_now()
WHERE category = 'workflow_template_step_metadata'
  AND version = 1;

SELECT pg_advisory_unlock(hashtext('202601221001_workflow_subworkflow_step_metadata_schemas'));
COMMIT;

