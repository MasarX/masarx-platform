-- Migration: Seed global renderer_defaults (no schema_registry change)
-- Date: 2025-11-13

BEGIN;

-- First ensure a settings_versions row exists
WITH upsert AS (
  SELECT
    'renderer_defaults'::text AS category,
    'global'::text AS scope_type,
    NULL::uuid AS scope_id,
    1::int AS version,
    jsonb_build_object(
      'fallback_title', 'Shipping Label',
      'primary_color', '#0D3A74'
    ) AS value
)
INSERT INTO settings_versions (category, scope_type, scope_id, version, value, approved_at)
SELECT category, scope_type, scope_id, version, value, now()
FROM upsert
ON CONFLICT DO NOTHING;

-- Then ensure settings has the active view entry
WITH upsert AS (
  SELECT
    'renderer_defaults'::text AS category,
    'global'::text AS scope_type,
    NULL::uuid AS scope_id
)
INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM settings_versions sv
JOIN upsert u
  ON sv.category = u.category
 AND ((sv.scope_id IS NULL AND u.scope_id IS NULL) OR sv.scope_id = u.scope_id)
 AND sv.scope_type = u.scope_type
WHERE NOT EXISTS (
  SELECT 1
  FROM settings s
  WHERE s.category = sv.category
    AND s.scope_type = sv.scope_type
    AND ((s.scope_id IS NULL AND sv.scope_id IS NULL) OR s.scope_id = sv.scope_id)
);

COMMIT;

