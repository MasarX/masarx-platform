-- Migration: strip invalid geocoding_policy.enabled from active settings
-- Purpose:
--   - Fix client-scoped geocoding_policy values that include legacy `enabled` key.
--   - Keep schema_registry strict (additionalProperties=false) while ensuring current
--     active settings conform to the schema.
-- Notes:
--   - Preserves historical settings_versions rows; only promotes a new version
--     without `enabled` and updates settings.cached_value + pointer.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-16
BEGIN;
SET search_path TO public, extensions, pg_temp;

-- Close the currently-active approved version first to satisfy the
-- partial unique index on (category, scope_type, scope_hash) for active rows.
UPDATE public.settings_versions sv
   SET effective_until = clock_timestamp()
  FROM public.settings s
 WHERE s.category = 'geocoding_policy'
   AND (s.cached_value ? 'enabled')
   AND sv.id = s.settings_version_id
   AND sv.scope_hash = s.scope_hash
   AND sv.effective_until IS NULL;

WITH affected AS (
  SELECT
    s.category,
    s.scope_type,
    s.scope_id,
    s.scope_hash,
    sv.version AS current_version,
    sv.schema_version,
    sv.value AS current_value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
   AND sv.scope_hash = s.scope_hash
  WHERE s.category = 'geocoding_policy'
    AND (s.cached_value ? 'enabled')
),
inserted AS (
  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    gen_random_uuid(),
    a.category,
    a.scope_type,
    a.scope_id,
    a.scope_hash,
    a.current_version + 1,
    (a.current_value - 'enabled'),
    a.schema_version,
    'migration: remove invalid geocoding_policy.enabled (schema v5)',
    clock_timestamp(),
    clock_timestamp()
  FROM affected a
  RETURNING id, category, scope_type, scope_hash, value
)
UPDATE public.settings s
   SET settings_version_id = i.id,
       cached_value = i.value,
       last_updated = clock_timestamp()
  FROM inserted i
 WHERE s.category = i.category
   AND s.scope_type = i.scope_type
   AND s.scope_hash = i.scope_hash;

COMMIT;
