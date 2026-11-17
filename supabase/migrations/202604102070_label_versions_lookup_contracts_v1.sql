-- Migration: replace label_versions literal enum checks with lookup contracts
-- Purpose:
--   - Keep label_versions.version_status and label_versions.job_purpose governed by
--     row-driven lookup contracts instead of hardcoded CHECK allowlists.
--   - Satisfy the no-literal-enum schema contract while preserving existing values.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102070_label_versions_lookup_contracts_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'label_version_status',
    'Label version lifecycle status for immutable active/superseded lineage.',
    'engineering',
    'tier_1',
    FALSE
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable;

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
  d.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('label_version_status', 'active', 'Active', 'Current active label version.', 10, TRUE),
    ('label_version_status', 'superseded', 'Superseded', 'Prior label version replaced by a newer active version.', 20, FALSE)
) AS v(category, value, label, description, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = EXCLUDED.status,
    retired_at = NULL,
    effective_until = NULL,
    updated_at = now();

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'label_versions', 'version_status', 'label_version_status'),
  ('public', 'label_versions', 'job_purpose', 'label_job_purpose')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

ALTER TABLE public.label_versions
  DROP CONSTRAINT IF EXISTS label_versions_version_status_chk,
  DROP CONSTRAINT IF EXISTS label_versions_job_purpose_chk;

SELECT pg_advisory_unlock(hashtext('202604102070_label_versions_lookup_contracts_v1'));

COMMIT;
