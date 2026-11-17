-- Migration 202511021200: Label design schema v2 + default template seed
-- Purpose: Introduce template-driven layout contract, enforce schema_registry RLS,
--          and seed global label template using the new contract.
-- Alignment: SIMPLE · SCALABLE · DYNAMIC · ZERO-HARDCODING · ZERO-REDUNDANCY
-- Dependencies: 202510200001_label_generation_core.sql (label baseline)

SET search_path = public;

-- ============================================================================
-- SECTION 1: Ensure schema_registry protected with RLS while allowing readers
-- ============================================================================

ALTER TABLE schema_registry
    ENABLE ROW LEVEL SECURITY;

-- Allow authenticated tenants to read configuration contracts for validation.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'schema_registry'
          AND policyname = 'schema_registry_select_authenticated'
    ) THEN
        CREATE POLICY schema_registry_select_authenticated
            ON schema_registry
            FOR SELECT
            TO authenticated
            USING (TRUE);
    END IF;
END;
$$;

-- Allow service_role (edge functions, automation) to read all schemas.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'schema_registry'
          AND policyname = 'schema_registry_select_service'
    ) THEN
        CREATE POLICY schema_registry_select_service
            ON schema_registry
            FOR SELECT
            TO service_role
            USING (TRUE);
    END IF;
END;
$$;

GRANT SELECT ON schema_registry TO authenticated;
GRANT SELECT ON schema_registry TO service_role;

-- ============================================================================
-- SECTION 2: Register label_design schema v2 (template-driven layout contract)
-- ============================================================================

WITH contract AS (
    SELECT
        'bbbb0000-0000-0000-0000-000000000921'::uuid AS id,
        'label_design'::text                      AS category,
        2                                         AS version,
        $${
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Label Design Configuration v2",
            "type": "object",
            "required": ["version", "templates"],
            "additionalProperties": false,
            "properties": {
                "version": { "type": "string", "minLength": 1 },
                "templates": {
                    "type": "object",
                    "minProperties": 1,
                    "additionalProperties": {
                        "type": "object",
                        "required": ["version", "page", "blocks"],
                        "additionalProperties": false,
                        "properties": {
                            "version": { "type": "string", "minLength": 1 },
                            "template_key": { "type": "string" },
                            "label_type": { "type": "string" },
                            "page": {
                                "type": "object",
                                "required": ["width_inch", "height_inch"],
                                "additionalProperties": false,
                                "properties": {
                                    "width_inch":  { "type": "number", "minimum": 1 },
                                    "height_inch": { "type": "number", "minimum": 1 },
                                    "margin_inch": { "type": "number", "minimum": 0 },
                                    "dpi":         { "type": "number", "minimum": 72 },
                                    "orientation": { "type": "string", "enum": ["portrait", "landscape"] }
                                }
                            },
                            "assets": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "required": ["name", "path"],
                                    "additionalProperties": false,
                                    "properties": {
                                        "name": { "type": "string" },
                                        "path": { "type": "string" },
                                        "content_type": { "type": "string" }
                                    }
                                },
                                "default": []
                            },
                            "blocks": {
                                "type": "array",
                                "minItems": 1,
                                "items": {
                                    "type": "object",
                                    "required": ["type", "x", "y"],
                                    "properties": {
                                        "type": { "type": "string", "enum": ["text", "barcode", "image"] },
                                        "x": { "type": "number" },
                                        "y": { "type": "number" },
                                        "width": { "type": "number" },
                                        "height": { "type": "number" },
                                        "font": { "type": "string" },
                                        "font_size": { "type": "number", "minimum": 1 },
                                        "color": {
                                            "type": "object",
                                            "properties": {
                                                "r": { "type": "number", "minimum": 0, "maximum": 1 },
                                                "g": { "type": "number", "minimum": 0, "maximum": 1 },
                                                "b": { "type": "number", "minimum": 0, "maximum": 1 }
                                            }
                                        },
                                        "value_path": { "type": "string" },
                                        "asset_ref": { "type": "string" },
                                        "fallback": { "type": "string" },
                                        "align": { "type": "string", "enum": ["left", "center", "right"] },
                                        "rotation": { "type": "number" }
                                    }
                                }
                            },
                            "barcode": {
                                "type": "object",
                                "required": ["type", "value_path"],
                                "properties": {
                                    "type": { "type": "string" },
                                    "value_path": { "type": "string" },
                                    "human_readable": { "type": "string" }
                                }
                            },
                            "max_attempts": { "type": "integer", "minimum": 1 },
                            "retry_backoff_seconds": {
                                "type": "array",
                                "items": { "type": "integer", "minimum": 0 }
                            },
                            "metadata": { "type": "object" }
                        }
                    }
                }
            }
        }$$::jsonb AS schema_doc,
        'Template-driven label layout contract with page geometry, blocks and assets.'::text AS description,
        $$[
            {
                "version": "2025-11-01",
                "templates": {
                    "shipping": {
                        "version": "1.0.0",
                        "template_key": "standard_4x6_v2",
                        "label_type": "shipping",
                        "page": {
                            "width_inch": 4,
                            "height_inch": 6,
                            "margin_inch": 0.125,
                            "dpi": 203,
                            "orientation": "portrait"
                        },
                        "assets": [
                            {"name": "logo", "path": "global/v1/logo.png", "content_type": "image/png"}
                        ],
                        "blocks": [
                            {"type": "text", "x": 24, "y": 396, "font": "Helvetica-Bold", "font_size": 20, "value_path": "shipment.tracking_number", "fallback": "TRACKING UNAVAILABLE"},
                            {"type": "barcode", "x": 24, "y": 260, "width": 260, "height": 90, "value_path": "shipment.tracking_number"},
                            {"type": "text", "x": 24, "y": 200, "font": "Helvetica", "font_size": 12, "value_path": "recipient.name"}
                        ],
                        "barcode": {"type": "CODE128", "value_path": "shipment.tracking_number"},
                        "max_attempts": 5,
                        "retry_backoff_seconds": [60, 180, 600]
                    }
                }
            }
        ]$$::jsonb AS examples
)
INSERT INTO schema_registry AS sr (
    id,
    category,
    version,
    schema,
    description,
    examples,
    is_active
)
SELECT
    contract.id,
    contract.category,
    contract.version,
    contract.schema_doc,
    contract.description,
    contract.examples,
    TRUE
FROM contract
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-- Close out any existing global template version to honour uniqueness constraints.
UPDATE settings_versions
SET effective_until = now()
WHERE category = 'label_design'
  AND scope_type = 'global'
  AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid) = '00000000-0000-0000-0000-000000000000'::uuid
  AND effective_until IS NULL;

WITH config AS (
    SELECT jsonb_build_object(
        'version', '2025-11-01',
        'templates', jsonb_build_object(
            'shipping', jsonb_build_object(
                'version', '1.0.0',
                'template_key', 'standard_4x6_v2',
                'label_type', 'shipping',
                'page', jsonb_build_object(
                    'width_inch', 4,
                    'height_inch', 6,
                    'margin_inch', 0.125,
                    'dpi', 203,
                    'orientation', 'portrait'
                ),
                'assets', jsonb_build_array(
                    jsonb_build_object(
                        'name', 'logo',
                        'path', 'global/v1/logo.png',
                        'content_type', 'image/png'
                    )
                ),
                'blocks', jsonb_build_array(
                    jsonb_build_object(
                        'type', 'text',
                        'x', 24,
                        'y', 396,
                        'font', 'Helvetica-Bold',
                        'font_size', 20,
                        'value_path', 'shipment.tracking_number',
                        'fallback', 'TRACKING UNAVAILABLE'
                    ),
                    jsonb_build_object(
                        'type', 'barcode',
                        'x', 24,
                        'y', 260,
                        'width', 260,
                        'height', 90,
                        'value_path', 'shipment.tracking_number'
                    ),
                    jsonb_build_object(
                        'type', 'text',
                        'x', 24,
                        'y', 200,
                        'font', 'Helvetica',
                        'font_size', 12,
                        'value_path', 'recipient.name',
                        'fallback', 'Name unavailable'
                    ),
                    jsonb_build_object(
                        'type', 'text',
                        'x', 24,
                        'y', 180,
                        'font', 'Helvetica',
                        'font_size', 11,
                        'value_path', 'destination.city',
                        'fallback', 'City unavailable'
                    )
                ),
                'barcode', jsonb_build_object(
                    'type', 'CODE128',
                    'value_path', 'shipment.tracking_number',
                    'human_readable', 'shipment.tracking_number'
                ),
                'max_attempts', 5,
                'retry_backoff_seconds', jsonb_build_array(60, 180, 600),
                'metadata', jsonb_build_object(
                    'description', 'Global default 4x6 shipping label template v2'
                )
            )
        )
    ) AS payload
),
upsert_version AS (
    INSERT INTO settings_versions (
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
        '77770000-0000-0000-0000-000000000152'::uuid,
        'label_design',
        'global',
        NULL,
        '00000000-0000-0000-0000-000000000000'::uuid,
        2,
        config.payload,
        2,
        'Seed global label template (template-driven layout v2)',
        now(),
        now()
    FROM config
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET value = EXCLUDED.value,
        schema_version = EXCLUDED.schema_version,
        change_reason = EXCLUDED.change_reason,
        approved_at = EXCLUDED.approved_at,
        effective_from = EXCLUDED.effective_from
    RETURNING id, value
),
apply_settings AS (
    INSERT INTO settings (
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
        gen_random_uuid(),
        'label_design',
        'global',
        NULL,
        '00000000-0000-0000-0000-000000000000'::uuid,
        upsert_version.id,
        upsert_version.value,
        now()
    FROM upsert_version
    ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
    SET settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated
)
SELECT 1;
