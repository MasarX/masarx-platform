-- Plan: PLAN-202603-runtime-deploy-health-mainline-convergence / Step: S02
-- Migration: align public_tracking_policy schema/examples with runtime reviewer-task org fallback

BEGIN;
SELECT pg_advisory_lock(hashtext('202603131700_public_tracking_policy_task_org_schema_fallback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH current_row AS (
  SELECT schema, examples
  FROM public.schema_registry
  WHERE category = 'public_tracking_policy'
    AND version = 1
  LIMIT 1
),
patched AS (
  SELECT
    jsonb_set(
      current_row.schema,
      '{properties,notifications,properties,task,required}',
      '["task_type_key","priority","sla_minutes"]'::jsonb,
      FALSE
    ) AS next_schema,
    COALESCE(
      (
        SELECT jsonb_agg(example #- ARRAY['notifications', 'task', 'organization_slug'])
        FROM jsonb_array_elements(COALESCE(current_row.examples, '[]'::jsonb)) AS example
      ),
      '[]'::jsonb
    ) AS next_examples
  FROM current_row
)
UPDATE public.schema_registry sr
SET schema = patched.next_schema,
    examples = patched.next_examples,
    description = 'Public landing tracking policy schema (v1) with shipment change execution and notification controls; reviewer task organization falls back to the support-case tenant org when notifications.task.organization_slug is unset.',
    is_active = TRUE
FROM patched
WHERE sr.category = 'public_tracking_policy'
  AND sr.version = 1
  AND (
    sr.schema IS DISTINCT FROM patched.next_schema
    OR sr.examples IS DISTINCT FROM patched.next_examples
    OR sr.description IS DISTINCT FROM 'Public landing tracking policy schema (v1) with shipment change execution and notification controls; reviewer task organization falls back to the support-case tenant org when notifications.task.organization_slug is unset.'
    OR sr.is_active IS DISTINCT FROM TRUE
  );

SELECT pg_advisory_unlock(hashtext('202603131700_public_tracking_policy_task_org_schema_fallback_v1'));
COMMIT;
