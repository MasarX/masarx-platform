-- Migration: workflow enabled-state lookup rows
-- Purpose: Console V2 Workflows trigger/schedule tables must render
-- operator labels from lookup rows instead of raw missing-key chips.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'workflow_binding_enabled_state',
    'Workflow binding trigger enabled/disabled state taxonomy for Console V2.',
    'engineering',
    'tier_1',
    false
  ),
  (
    'workflow_schedule_enabled_state',
    'Workflow schedule trigger enabled/paused state taxonomy for Console V2.',
    'engineering',
    'tier_1',
    false
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

WITH lookup_rows AS (
  SELECT *
  FROM (
    VALUES
      (
        'workflow_binding_enabled_state',
        'enabled',
        'Enabled',
        'Workflow binding trigger is active.',
        10,
        true,
        '{"tone":"good"}'::jsonb
      ),
      (
        'workflow_binding_enabled_state',
        'disabled',
        'Disabled',
        'Workflow binding trigger is disabled.',
        20,
        false,
        '{"tone":"neutral"}'::jsonb
      ),
      (
        'workflow_schedule_enabled_state',
        'enabled',
        'Enabled',
        'Workflow schedule trigger is active.',
        10,
        true,
        '{"tone":"good"}'::jsonb
      ),
      (
        'workflow_schedule_enabled_state',
        'paused',
        'Paused',
        'Workflow schedule trigger exists but is paused.',
        20,
        false,
        '{"tone":"warn"}'::jsonb
      )
  ) AS v(category, value, label, description, sort_order, is_default, metadata)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  r.value,
  r.label,
  r.description,
  r.sort_order,
  r.is_default,
  'active',
  r.metadata
FROM public.lookup_definitions d
JOIN lookup_rows r
  ON r.category = d.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = now();

COMMIT;
