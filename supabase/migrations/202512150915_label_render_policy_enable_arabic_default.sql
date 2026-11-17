-- Migration: Enable Arabic shaping by default (label_render_policy global)
-- Purpose:
--  - Keep label structure English by default, while allowing data fields to include Arabic safely.
--  - Enable Arabic shaping + direction auto at the global policy level (settings ladder still overrides).

BEGIN;

SET search_path TO public, pg_temp;

UPDATE settings_versions
SET
  value = jsonb_set(
    jsonb_set(value, '{arabic,enabled}', 'true'::jsonb, TRUE),
    '{arabic,direction}',
    '"auto"'::jsonb,
    TRUE
  ),
  change_reason = 'Enable Arabic shaping by default (global label_render_policy)',
  approved_at = workflow_now(),
  effective_from = workflow_now()
WHERE category = 'label_render_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

UPDATE settings
SET
  cached_value = jsonb_set(
    jsonb_set(cached_value, '{arabic,enabled}', 'true'::jsonb, TRUE),
    '{arabic,direction}',
    '"auto"'::jsonb,
    TRUE
  ),
  last_updated = workflow_now()
WHERE category = 'label_render_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

COMMIT;

