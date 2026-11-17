-- Migration: strip legacy geocoding_policy.enabled drift (active settings)
-- Purpose:
--   - Guard against legacy `geocoding_policy.enabled` being reintroduced by tools/tests.
--   - Keep active settings strictly aligned with schema_registry (additionalProperties=false).
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-26
BEGIN;
SET search_path TO public, extensions, pg_temp;

-- Close any active settings_versions rows that contain the legacy top-level key.
WITH active AS (
  SELECT
    sv.id,
    sv.category,
    sv.scope_type,
    sv.scope_id,
    sv.scope_hash,
    sv.version AS current_version,
    sv.schema_version,
    sv.value AS current_value
  FROM public.settings_versions sv
  WHERE sv.category = 'geocoding_policy'
    AND sv.effective_until IS NULL
    AND (sv.value ? 'enabled')
),
closed AS (
  UPDATE public.settings_versions sv
     SET effective_until = clock_timestamp()
    FROM active a
   WHERE sv.id = a.id
  RETURNING a.*
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
    c.category,
    c.scope_type,
    c.scope_id,
    c.scope_hash,
    c.current_version + 1,
    (c.current_value - 'enabled'),
    c.schema_version,
    'migration: strip legacy geocoding_policy.enabled drift',
    clock_timestamp(),
    clock_timestamp()
  FROM closed c
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

