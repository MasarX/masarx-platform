-- Plan: PLAN-202602-tenant-signup-lookup-contracts-enum-fix / Step: S04
-- Migration: Register tenant_signup_requests status/decision lookup contracts
--
-- Why
-- - pgTAP policy forbids literal-list enum CHECK constraints in app schemas.
-- - tenant_signup_requests.status and tenant_signup_requests.review_decision were using hardcoded IN (...) checks.
--
-- What
-- - Register row-driven lookup categories + values for tenant signup request status and reviewer decision.
-- - Bind tenant_signup_requests columns through lookup_column_contracts.
-- - Apply generic lookup enforcement triggers while preserving existing lookup-driven CHECK constraints in dev.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Lookup categories (SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'tenant_signup_request_status',
    'Tenant signup request lifecycle status (pending/approved/rejected).',
    'engineering',
    'tier_1',
    false
  ),
  (
    'tenant_signup_review_decision',
    'Reviewer decision domain for tenant signup requests (approved/rejected).',
    'engineering',
    'tier_1',
    false
  )
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('tenant_signup_request_status', 'pending', 'Pending', 10, true),
    ('tenant_signup_request_status', 'approved', 'Approved', 20, false),
    ('tenant_signup_request_status', 'rejected', 'Rejected', 30, false),
    ('tenant_signup_review_decision', 'approved', 'Approved', 10, true),
    ('tenant_signup_review_decision', 'rejected', 'Rejected', 20, false)
) v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Column contracts + trigger enforcement
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'tenant_signup_requests', 'status', 'tenant_signup_request_status'),
  ('public', 'tenant_signup_requests', 'review_decision', 'tenant_signup_review_decision')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

COMMIT;
