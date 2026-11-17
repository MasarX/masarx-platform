-- Migration: label_print_profile (printer capability + barcode rendering defaults)
-- Purpose:
--  - Add schema_registry contract for label_print_profile v1.
--  - Seed global defaults (203dpi thermal) for deterministic barcode dot snapping.
-- Notes:
--  - This category is intended to describe printer capabilities (dpi/media) and
--    barcode rendering defaults (quiet zone + module dots). Quality actions
--    remain governed by label_render_policy.barcode.*.

BEGIN;

SET search_path TO public, pg_temp;

-- -----------------------------------------------------------------------------
-- 1) schema_registry: label_print_profile v1
-- -----------------------------------------------------------------------------

WITH profile_schema AS (
  SELECT $$
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "label_print_profile.schema.json",
    "title": "label_print_profile",
    "type": "object",
    "required": ["version", "profile_key", "dpi"],
    "additionalProperties": false,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "profile_key": { "type": "string", "minLength": 1, "maxLength": 64 },
      "dpi": { "type": "integer", "minimum": 72, "maximum": 600 },
      "media": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": { "type": "string", "enum": ["thermal", "laser", "inkjet", "unknown"] },
          "darkness": { "type": "integer", "minimum": 0, "maximum": 30 },
          "width_inch": { "type": "number", "minimum": 1, "maximum": 10 },
          "height_inch": { "type": "number", "minimum": 1, "maximum": 15 }
        }
      },
      "barcode": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "quiet_zone_modules": { "type": "integer", "minimum": 0, "maximum": 40 },
          "min_quiet_zone_modules": { "type": "integer", "minimum": 0, "maximum": 40 },
          "target_module_width_dots": { "type": "integer", "minimum": 1, "maximum": 10 },
          "hard_min_module_width_dots": { "type": "integer", "minimum": 1, "maximum": 10 }
        }
      }
    }
  }
  $$::jsonb AS schema_doc,
  $$[
    {
      "version": 1,
      "profile_key": "default_203dpi",
      "dpi": 203,
      "media": { "kind": "thermal", "darkness": 18, "width_inch": 4, "height_inch": 6 },
      "barcode": { "quiet_zone_modules": 10, "min_quiet_zone_modules": 4, "target_module_width_dots": 2, "hard_min_module_width_dots": 1 }
    },
    {
      "version": 1,
      "profile_key": "high_300dpi",
      "dpi": 300,
      "media": { "kind": "thermal", "darkness": 18, "width_inch": 4, "height_inch": 6 },
      "barcode": { "quiet_zone_modules": 10, "min_quiet_zone_modules": 6, "target_module_width_dots": 3, "hard_min_module_width_dots": 2 }
    }
  ]$$::jsonb AS examples
)
INSERT INTO schema_registry (id, category, version, schema, description, examples, is_active, created_at)
SELECT
  'cccc0000-0000-0000-0000-000000001111',
  'label_print_profile',
  1,
  profile_schema.schema_doc,
  'Printer capability profile (dpi/media) + barcode rendering defaults for dot-snapped vector rendering.',
  profile_schema.examples,
  TRUE,
  workflow_now()
FROM profile_schema
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now();

-- -----------------------------------------------------------------------------
-- 2) Global defaults: seed baseline (non-breaking)
-- -----------------------------------------------------------------------------

WITH default_profile AS (
  SELECT $$
  {
    "version": 1,
    "profile_key": "default_203dpi",
    "dpi": 203,
    "media": { "kind": "thermal", "darkness": 18, "width_inch": 4, "height_inch": 6 },
    "barcode": { "quiet_zone_modules": 10, "min_quiet_zone_modules": 4, "target_module_width_dots": 2, "hard_min_module_width_dots": 1 }
  }
  $$::jsonb AS payload
)
INSERT INTO settings_versions (
  id, category, scope_type, scope_id, scope_hash,
  version, value, schema_version, change_reason, approved_at, effective_from
)
SELECT
  'cccc1111-0000-0000-0000-000000001111',
  'label_print_profile',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  1,
  default_profile.payload,
  1,
  'Initial label_print_profile baseline (default_203dpi)',
  workflow_now(),
  workflow_now()
FROM default_profile
ON CONFLICT (id, scope_hash) DO UPDATE
SET value = EXCLUDED.value,
    change_reason = EXCLUDED.change_reason,
    approved_at = EXCLUDED.approved_at,
    effective_from = EXCLUDED.effective_from;

WITH default_profile AS (
  SELECT $$
  {
    "version": 1,
    "profile_key": "default_203dpi",
    "dpi": 203,
    "media": { "kind": "thermal", "darkness": 18, "width_inch": 4, "height_inch": 6 },
    "barcode": { "quiet_zone_modules": 10, "min_quiet_zone_modules": 4, "target_module_width_dots": 2, "hard_min_module_width_dots": 1 }
  }
  $$::jsonb AS payload
)
INSERT INTO settings (
  id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
)
SELECT
  'cccc2222-0000-0000-0000-000000001111',
  'label_print_profile',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'cccc1111-0000-0000-0000-000000001111',
  default_profile.payload,
  workflow_now()
FROM default_profile
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

COMMIT;

