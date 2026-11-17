-- Test: Settings category registry governance (schemas + global defaults)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

CREATE TEMP TABLE _settings_category_registry AS
SELECT
  category,
  requires_schema,
  requires_global_default
FROM public.settings_category_registry
ORDER BY category;

SELECT plan(
  (SELECT COUNT(*)::INT FROM _settings_category_registry WHERE requires_schema = TRUE)
  + (SELECT COUNT(*)::INT FROM _settings_category_registry WHERE requires_global_default = TRUE)
);

-- 1) Every category marked requires_schema must have an active schema_registry row.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry sr
    WHERE sr.category = r.category
      AND sr.is_active = TRUE
    LIMIT 1
  ),
  format('schema_registry active for category=%s', r.category)
)
FROM _settings_category_registry r
WHERE r.requires_schema = TRUE;

-- 2) Every category marked requires_global_default must have a global settings row.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = r.category
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    LIMIT 1
  ),
  format('settings global default present for category=%s', r.category)
)
FROM _settings_category_registry r
WHERE r.requires_global_default = TRUE;

SELECT finish();

ROLLBACK;

