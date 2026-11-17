-- Plan: PLAN-202602-ci-cd-deploy-hardening / Step: S04
-- Migration: restore manual_review_task_type value used by auto_learn_geography
-- Purpose:
--   - Ensure lookup contract for public.manual_review_tasks.task_type allows
--     geocoding_auto_learn (used by auto-learn queue paths).
--   - Keep lookup contracts as SSOT (no hardcoded enum bypasses).

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'manual_review_task_type',
  'Manual review task type',
  'engineering',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO NOTHING;

WITH target AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'manual_review_task_type'
  LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status
)
SELECT
  target.id,
  'geocoding_auto_learn',
  'Geocoding Auto Learn',
  15,
  FALSE,
  'active'
FROM target
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  status = 'active',
  retired_at = NULL;

COMMIT;
