-- Plan: PLAN-202603-marketplace-network-v1 / Step: S95
-- Migration: Add marketplace decision_category lookup values required by marketplace policy logging.
-- Rationale:
--   - `decision_log.decision_category` is contract-enforced through lookup_values.
--   - Marketplace lifecycle RPCs emit policy-scoped decision categories that must be registered.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active'
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    ('marketplace_compliance_policy', 'Marketplace Compliance Policy', 'Marketplace onboarding, approval, and compliance decisions', 380),
    ('marketplace_request_policy', 'Marketplace Request Policy', 'Marketplace request creation and lifecycle policy decisions', 390),
    ('marketplace_visibility_policy', 'Marketplace Visibility Policy', 'Marketplace visibility and release policy decisions', 400)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  status = 'active';

COMMIT;
