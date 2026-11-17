-- Migration: label_versions lookup contracts
-- Purpose:
--   - Replace literal enum-like CHECK constraints on public.label_versions with
--     row-driven lookup contracts.
--   - Reuse the existing label_job_purpose category and introduce
--     label_version_status for active/superseded lineage states.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('label_version_status', 'Label version lineage status (active/superseded)', 'engineering', 'tier_1', false)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('label_version_status', 'active', 'Active', 10, true),
    ('label_version_status', 'superseded', 'Superseded', 20, false)
) AS v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'label_versions', 'job_purpose', 'label_job_purpose'),
  ('public', 'label_versions', 'version_status', 'label_version_status')
ON CONFLICT (table_schema, table_name, column_name)
DO UPDATE SET
  lookup_category = EXCLUDED.lookup_category,
  allowed_values = NULL;

SELECT public.apply_lookup_column_contracts('public');

ALTER TABLE public.label_versions
  DROP CONSTRAINT IF EXISTS label_versions_job_purpose_chk,
  DROP CONSTRAINT IF EXISTS label_versions_version_status_chk;

COMMIT;
