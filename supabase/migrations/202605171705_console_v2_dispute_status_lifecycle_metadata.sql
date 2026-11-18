-- Console V2 Finance Disputes lifecycle metadata
--
-- The Finance Disputes surface drives every action gate from lookup metadata.
-- Shared/live databases already had marketplace_dispute_status display rows,
-- but not the Console-facing dispute_status lifecycle category. Seed both
-- contracts so the UI, RPC guards, and browser-backed operator flow stay
-- row-driven instead of falling back to hardcoded status branches.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605171705_console_v2_dispute_status_lifecycle_metadata'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  organization_id,
  scope_type
)
VALUES
  (
    'dispute_status',
    'Console Finance Disputes lifecycle status metadata for action gating.',
    'finance',
    'tier_1',
    FALSE,
    NULL,
    'global'
  ),
  (
    'marketplace_dispute_status',
    'Marketplace dispute lifecycle status metadata aligned to Console Finance Disputes.',
    'engineering',
    'tier_1',
    FALSE,
    NULL,
    'global'
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    scope_type = EXCLUDED.scope_type,
    updated_at = now();

WITH status_rows(value, label, sort_order, is_default, metadata) AS (
  VALUES
    ('open',         'Open',         10, TRUE,  '{"tone":"info","lifecycle":"working","is_terminal":false,"allows_acknowledge":true,"allows_escalate":true,"allows_reject":true,"allows_resolve":true}'::jsonb),
    ('submitted',    'Submitted',    15, FALSE, '{"tone":"info","lifecycle":"working","is_terminal":false,"allows_acknowledge":true,"allows_escalate":true,"allows_reject":true,"allows_resolve":true}'::jsonb),
    ('under_review', 'Under review', 20, FALSE, '{"tone":"warn","lifecycle":"working","is_terminal":false,"allows_acknowledge":true,"allows_escalate":true,"allows_reject":true,"allows_resolve":true}'::jsonb),
    ('resolved',     'Resolved',     30, FALSE, '{"tone":"good","lifecycle":"terminal","is_terminal":true,"allows_acknowledge":false,"allows_escalate":false,"allows_reject":false,"allows_resolve":false}'::jsonb),
    ('rejected',     'Rejected',     40, FALSE, '{"tone":"neutral","lifecycle":"terminal","is_terminal":true,"allows_acknowledge":false,"allows_escalate":false,"allows_reject":false,"allows_resolve":false}'::jsonb)
),
target_categories(category) AS (
  VALUES ('dispute_status'), ('marketplace_dispute_status')
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT ld.id,
       sr.value,
       sr.label,
       sr.sort_order,
       sr.is_default,
       'active',
       sr.metadata
FROM public.lookup_definitions ld
JOIN target_categories tc ON tc.category = ld.category
CROSS JOIN status_rows sr
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605171705_console_v2_dispute_status_lifecycle_metadata'));

COMMIT;
