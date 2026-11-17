-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S03
-- Migration: label_media_catalog (SSOT size presets for designer)
-- Purpose:
--   - Provide a ladder-resolved, row-driven catalog of common label media sizes
--     (and optional DPI hints) for the browser label designer.
--   - Keep presets data-defined: UI reads the catalog; no hardcoded lists in code.
BEGIN;
SET search_path TO public, pg_temp;

WITH contract AS (
  SELECT
    $${
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "label_media_catalog.schema.v1.json",
      "title": "label_media_catalog",
      "type": "object",
      "required": ["version", "items"],
      "additionalProperties": false,
      "properties": {
        "version": { "type": "integer", "minimum": 1 },
        "items": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/$defs/item" }
        }
      },
      "$defs": {
        "item": {
          "type": "object",
          "required": ["key", "label_en", "label_ar", "width_inch", "height_inch"],
          "additionalProperties": false,
          "properties": {
            "key": { "type": "string", "minLength": 1, "maxLength": 64 },
            "label_en": { "type": "string", "minLength": 1, "maxLength": 120 },
            "label_ar": { "type": "string", "minLength": 1, "maxLength": 120 },
            "width_inch": { "type": "number", "minimum": 1, "maximum": 10 },
            "height_inch": { "type": "number", "minimum": 1, "maximum": 15 },
            "dpi": { "type": "integer", "minimum": 72, "maximum": 600 },
            "print_profile_key": { "type": "string", "minLength": 1, "maxLength": 64 },
            "notes": { "type": "string", "maxLength": 200 }
          }
        }
      }
    }$$::jsonb AS schema_doc,
    $${
      "version": 1,
      "items": [
        {
          "key": "4x6_203",
          "label_en": "4x6 in (203 dpi)",
          "label_ar": "Ù¤Ã—Ù¦ Ø¨ÙˆØµØ© (203 dpi)",
          "width_inch": 4,
          "height_inch": 6,
          "dpi": 203,
          "print_profile_key": "default_203dpi"
        },
        {
          "key": "4x6_300",
          "label_en": "4x6 in (300 dpi)",
          "label_ar": "Ù¤Ã—Ù¦ Ø¨ÙˆØµØ© (300 dpi)",
          "width_inch": 4,
          "height_inch": 6,
          "dpi": 300,
          "print_profile_key": "high_300dpi"
        },
        {
          "key": "4x4_203",
          "label_en": "4x4 in (203 dpi)",
          "label_ar": "Ù¤Ã—Ù¤ Ø¨ÙˆØµØ© (203 dpi)",
          "width_inch": 4,
          "height_inch": 4,
          "dpi": 203
        }
      ]
    }$$::jsonb AS default_value,
    'Label media presets for the label designer (ladder-resolved; SSOT).'::text AS description
),
category_seed AS (
  INSERT INTO public.settings_category_registry (
    category,
    description,
    requires_schema,
    requires_global_default,
    side_effecting,
    safe_missing_behavior,
    allowed_scopes
  )
  VALUES (
    'label_media_catalog',
    'Label media presets for designer (common sizes + optional DPI + optional print_profile_key hint).',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender"]'::jsonb
  )
  ON CONFLICT (category) DO NOTHING
  RETURNING 1
),
category_update AS (
  UPDATE public.settings_category_registry
  SET
    description = 'Label media presets for designer (common sizes + optional DPI + optional print_profile_key hint).',
    requires_schema = TRUE,
    requires_global_default = TRUE,
    side_effecting = FALSE,
    safe_missing_behavior = 'hard_fail',
    allowed_scopes = '["global","tenant","client","sender"]'::jsonb,
    updated_at = now()
  WHERE category = 'label_media_catalog'
  RETURNING 1
),
schema_seed AS (
  INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active, created_at)
  SELECT
    'label_media_catalog',
    1,
    contract.schema_doc,
    contract.description,
    jsonb_build_array(contract.default_value),
    TRUE,
    workflow_now()
  FROM contract
  ON CONFLICT (category, version) DO NOTHING
  RETURNING 1
),
schema_update AS (
  UPDATE public.schema_registry
  SET
    schema = contract.schema_doc,
    description = contract.description,
    examples = jsonb_build_array(contract.default_value),
    is_active = TRUE,
    created_at = workflow_now()
  FROM contract
  WHERE category = 'label_media_catalog'
    AND version = 1
  RETURNING 1
),
activate_schema AS (
  UPDATE public.schema_registry
  SET is_active = CASE WHEN version = 1 THEN TRUE ELSE FALSE END
  WHERE category = 'label_media_catalog'
  RETURNING 1
),
version_seed AS (
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
    effective_from,
    effective_until
  )
  SELECT
    uuid_from_hash('label_media_catalog:global:1'),
    'label_media_catalog',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    contract.default_value,
    1,
    'Seed global label_media_catalog baseline',
    workflow_now(),
    workflow_now(),
    NULL
  FROM contract
  ON CONFLICT (id, scope_hash) DO NOTHING
  RETURNING 1
),
version_update AS (
  UPDATE public.settings_versions
  SET
    value = contract.default_value,
    schema_version = 1,
    change_reason = 'Seed global label_media_catalog baseline',
    approved_at = workflow_now(),
    effective_from = workflow_now(),
    effective_until = NULL
  FROM contract
  WHERE id = uuid_from_hash('label_media_catalog:global:1')
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  RETURNING 1
),
settings_seed AS (
  INSERT INTO public.settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    uuid_from_hash('label_media_catalog:global:cache'),
    'label_media_catalog',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    uuid_from_hash('label_media_catalog:global:1'),
    contract.default_value,
    workflow_now()
  FROM contract
  ON CONFLICT (category, scope_type, scope_hash) DO NOTHING
  RETURNING 1
),
settings_update AS (
  UPDATE public.settings
  SET
    settings_version_id = uuid_from_hash('label_media_catalog:global:1'),
    cached_value = contract.default_value,
    last_updated = workflow_now()
  FROM contract
  WHERE category = 'label_media_catalog'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  RETURNING 1
)
SELECT 1;

COMMIT;
