-- Migration: label_render_policy schema update (barcode defaults + scan reliability knobs)
-- Purpose:
--  - Add optional `barcode` settings to label_render_policy (quiet zones + min dots per module + optional dpi override).
--  - Seed global defaults without overriding existing custom barcode settings.

BEGIN;

SET search_path TO public, pg_temp;

-- -----------------------------------------------------------------------------
-- 1) schema_registry: label_render_policy v1 additions (non-breaking)
-- -----------------------------------------------------------------------------

UPDATE schema_registry
SET
  schema = jsonb_set(
    schema,
    '{properties,barcode}',
    $$
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "dpi": { "type": "integer", "minimum": 72, "maximum": 600 },
        "quiet_zone_modules": { "type": "integer", "minimum": 0, "maximum": 40 },
        "min_quiet_zone_modules": { "type": "integer", "minimum": 0, "maximum": 40 },
        "target_module_width_dots": { "type": "integer", "minimum": 1, "maximum": 10 },
        "hard_min_module_width_dots": { "type": "integer", "minimum": 1, "maximum": 10 }
      }
    }
    $$::jsonb,
    TRUE
  ),
  examples = jsonb_set(
    examples,
    '{0,barcode}',
    $$
    {
      "quiet_zone_modules": 10,
      "min_quiet_zone_modules": 4,
      "target_module_width_dots": 2,
      "hard_min_module_width_dots": 1
    }
    $$::jsonb,
    TRUE
  ),
  is_active = TRUE,
  created_at = workflow_now()
WHERE category = 'label_render_policy'
  AND version = 1;

-- -----------------------------------------------------------------------------
-- 2) Global defaults: add barcode defaults (non-breaking)
-- -----------------------------------------------------------------------------

UPDATE settings_versions
SET
  value = CASE
    WHEN value ? 'barcode' THEN value
    ELSE jsonb_set(
      value,
      '{barcode}',
      $$
      {
        "quiet_zone_modules": 10,
        "min_quiet_zone_modules": 4,
        "target_module_width_dots": 2,
        "hard_min_module_width_dots": 1
      }
      $$::jsonb,
      TRUE
    )
  END,
  change_reason = 'Update global label_render_policy: add barcode defaults',
  approved_at = workflow_now(),
  effective_from = workflow_now()
WHERE category = 'label_render_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

UPDATE settings
SET
  cached_value = CASE
    WHEN cached_value ? 'barcode' THEN cached_value
    ELSE jsonb_set(
      cached_value,
      '{barcode}',
      $$
      {
        "quiet_zone_modules": 10,
        "min_quiet_zone_modules": 4,
        "target_module_width_dots": 2,
        "hard_min_module_width_dots": 1
      }
      $$::jsonb,
      TRUE
    )
  END,
  last_updated = workflow_now()
WHERE category = 'label_render_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

COMMIT;

