-- Migration: Fill missing settings rows for tenant renderer_defaults based on settings_versions
-- Date: 2025-11-13

BEGIN;

INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM settings_versions sv
LEFT JOIN settings s
  ON s.category = sv.category
 AND s.scope_type = sv.scope_type
 AND ((s.scope_id IS NULL AND sv.scope_id IS NULL) OR s.scope_id = sv.scope_id)
WHERE sv.category = 'renderer_defaults'
  AND sv.scope_type = 'tenant'
  AND s.id IS NULL;

COMMIT;

