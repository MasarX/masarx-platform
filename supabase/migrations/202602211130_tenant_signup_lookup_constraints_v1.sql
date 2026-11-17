-- Plan: PLAN-202602-unmerged-commit-backfill / Step: S95
-- Purpose:
--   - Remove literal allowlist CHECK constraints from tenant_signup_requests.
--   - Enforce signup request status/review_decision through lookup contracts (row-driven).

BEGIN;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'tenant_signup_request_status',
    'Canonical status taxonomy for tenant signup requests.',
    'platform_owner',
    'admin_only',
    TRUE
  ),
  (
    'tenant_signup_review_decision',
    'Allowed review decisions for tenant signup requests.',
    'platform_owner',
    'admin_only',
    TRUE
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, status)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active'
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('tenant_signup_request_status', 'pending', 'Pending', 'Awaiting manual review', 10, TRUE),
    ('tenant_signup_request_status', 'approved', 'Approved', 'Review accepted and approved', 20, FALSE),
    ('tenant_signup_request_status', 'rejected', 'Rejected', 'Review completed with rejection', 30, FALSE),
    ('tenant_signup_review_decision', 'approved', 'Approved', 'Explicit approval decision', 10, TRUE),
    ('tenant_signup_review_decision', 'rejected', 'Rejected', 'Explicit rejection decision', 20, FALSE)
) AS v(category, value, label, description, sort_order, is_default)
  ON v.category = ld.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = EXCLUDED.status;

ALTER TABLE public.tenant_signup_requests
  DROP CONSTRAINT IF EXISTS tenant_signup_requests_status_ck,
  DROP CONSTRAINT IF EXISTS tenant_signup_requests_review_decision_ck;

ALTER TABLE public.tenant_signup_requests
  ADD CONSTRAINT tenant_signup_requests_status_ck
  CHECK (public.is_active_lookup_value_v1('tenant_signup_request_status', status, TRUE)),
  ADD CONSTRAINT tenant_signup_requests_review_decision_ck
  CHECK (
    review_decision IS NULL
    OR public.is_active_lookup_value_v1('tenant_signup_review_decision', review_decision, TRUE)
  );

COMMIT;
