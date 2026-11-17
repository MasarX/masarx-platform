-- Plan: PLAN-202603-marketplace-network-merge-queue-fix / Step: S01
-- Migration: allow public_tracking_policy task organization slug to resolve via runtime fallback

BEGIN;
SELECT pg_advisory_lock(hashtext('202603132110_public_tracking_policy_task_org_schema_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
SET schema = jsonb_set(
      schema,
      '{properties,notifications,properties,task,required}',
      '["task_type_key","priority","sla_minutes"]'::jsonb,
      FALSE
    ),
    description = 'Public landing tracking policy schema (v1) with shipment change execution and notification controls; task organization falls back from support-case context when omitted.'
WHERE category = 'public_tracking_policy'
  AND version = 1
  AND COALESCE(
        schema #> '{properties,notifications,properties,task,required}',
        '[]'::jsonb
      ) = '["organization_slug","task_type_key","priority","sla_minutes"]'::jsonb;

SELECT pg_advisory_unlock(hashtext('202603132110_public_tracking_policy_task_org_schema_fix_v1'));
COMMIT;
