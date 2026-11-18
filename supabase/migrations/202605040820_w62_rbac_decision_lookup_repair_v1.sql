-- W62 RBAC role-management RPCs emit append-only decision_log rows with
-- access_policy.rbac_* categories. Keep the lookup-enforced decision contract
-- aligned with the canonical role lifecycle before Console V2 calls these APIs.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031750_w62_rbac_decision_lookup_repair_v1'));
SET search_path TO public, extensions, pg_temp;

WITH categories(value, label, sort_order) AS (
  VALUES
    ('access_policy.rbac_create_role', 'Access Policy RBAC Create Role', 2290),
    ('access_policy.rbac_update_role', 'Access Policy RBAC Update Role', 2300),
    ('access_policy.rbac_delete_role', 'Access Policy RBAC Delete Role', 2310),
    ('access_policy.rbac_grant_role', 'Access Policy RBAC Grant Role', 2320),
    ('access_policy.rbac_revoke_role', 'Access Policy RBAC Revoke Role', 2330)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
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
  c.value,
  c.label,
  'Decision category emitted by canonical RBAC role-management RPCs.',
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'w62_rbac_decision_lookup_repair_v1',
    'tone', 'info'
  )
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

WITH outcomes(value, label, sort_order, tone) AS (
  VALUES
    ('granted', 'Granted', 2080, 'good')
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1
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
  o.value,
  o.label,
  'Decision outcome emitted by canonical RBAC role-management RPCs.',
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'w62_rbac_decision_lookup_repair_v1',
    'tone', o.tone
  )
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605031750_w62_rbac_decision_lookup_repair_v1'));
COMMIT;
