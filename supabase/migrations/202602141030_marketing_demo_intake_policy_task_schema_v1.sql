-- Plan: PLAN-202602-landing-contact-sales-intake / Step: S04
-- Migration: marketing_demo_intake_policy schema_registry v1 - add task routing config (additive)
-- Date: 2026-02-14
--
-- Notes:
--   - Keep category name for backward compatibility (append-only posture).
--   - Additive schema change: introduces policy.task for internal follow-up routing config.

BEGIN;
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_task_schema JSONB := jsonb_build_object(
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'organization_slug', jsonb_build_object('type', 'string'),
      'task_type_key', jsonb_build_object('type', 'string'),
      'queue_key', jsonb_build_object('type', 'string'),
      'priority', jsonb_build_object('type', 'integer', 'minimum', 0),
      'sla_minutes', jsonb_build_object('type', 'integer', 'minimum', 0)
    )
  );
  v_task_example JSONB := jsonb_build_object(
    'organization_slug', 'global-root',
    'task_type_key', 'marketing_lead_followup'
  );
BEGIN
  UPDATE public.schema_registry
     SET schema = jsonb_set(COALESCE(schema, '{}'::jsonb), '{properties,task}', v_task_schema, TRUE),
         examples = CASE
           WHEN examples IS NULL
             OR jsonb_typeof(examples) IS DISTINCT FROM 'array'
             OR jsonb_array_length(examples) = 0
           THEN jsonb_build_array(
             jsonb_build_object(
               'version', 1,
               'enabled', TRUE,
               'turnstile', jsonb_build_object('required', TRUE),
               'rate_limit', jsonb_build_object('window_seconds', 60, 'max_requests', 15),
               'dedupe', jsonb_build_object('window_seconds', 3600),
               'task', v_task_example
             )
           )
           ELSE jsonb_set(examples, '{0,task}', v_task_example, TRUE)
         END,
         is_active = TRUE,
         updated_at = now()
   WHERE category = 'marketing_demo_intake_policy'
     AND version = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'schema_registry missing marketing_demo_intake_policy v1'
      USING ERRCODE = '23503';
  END IF;
END;
$$;

COMMIT;

