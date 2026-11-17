-- Plan: PLAN-202603-shared-mapping-studio / Step: S04
-- Migration: Register tabular_import as a canonical mapping_type lookup value

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091120_mapping_type_lookup_tabular_import_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default
)
SELECT
  d.id,
  'tabular_import',
  'Tabular Import',
  60,
  FALSE
FROM public.lookup_definitions d
WHERE d.category = 'mapping_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202603091120_mapping_type_lookup_tabular_import_v1'));
COMMIT;
