-- Migration: Seed "soft_fail" in safe_missing_behavior lookup contract.
-- Rationale:
--   Integration plugin policy categories use safe_missing_behavior='soft_fail'
--   for optional AI-assist settings fallback. Shared environments that do not
--   yet have this lookup value reject settings_category_registry upserts.

BEGIN;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default
)
SELECT
  d.id,
  'soft_fail',
  'Soft Fail',
  35,
  false
FROM public.lookup_definitions d
WHERE d.category = 'safe_missing_behavior'
ON CONFLICT (lookup_definition_id, value)
DO UPDATE SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  retired_at = NULL;

COMMIT;
