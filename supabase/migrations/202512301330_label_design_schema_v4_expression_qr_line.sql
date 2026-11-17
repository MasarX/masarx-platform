-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S01
-- Migration: label_design schema v4 (expression AST + QR + line blocks)
-- Purpose:
--   - Extend label_design contract to support template-driven text composition (safe expression AST),
--     QR barcodes, and explicit line blocks while remaining backward compatible.
--   - Keep rendering SIMPLE/SCALABLE/DYNAMIC: templates are data-defined; code reads behavior from rows.
-- Notes:
--   - v1 designer prints DB values as-is; no language switching or auto-translation.
--   - This migration updates schema_registry + label_design schema_version pointers only (no data rewrite).

BEGIN;

SET search_path TO public, pg_temp;

-- ---------------------------------------------------------------------------
-- label_design schema v4 (superset of v3; backward compatible)
-- ---------------------------------------------------------------------------
WITH contract AS (
  SELECT
    $$
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "label_design.schema.v4.json",
      "title": "label_design",
      "type": "object",
      "required": ["version", "templates"],
      "additionalProperties": false,
      "properties": {
        "version": { "type": "string", "minLength": 1 },
        "templates": {
          "type": "object",
          "minProperties": 1,
          "additionalProperties": { "$ref": "#/$defs/template" }
        }
      },
      "$defs": {
        "color": {
          "oneOf": [
            { "type": "string", "minLength": 1 },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "r": { "type": "number" },
                "g": { "type": "number" },
                "b": { "type": "number" }
              }
            }
          ]
        },
        "render_condition": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "path": { "type": "string", "minLength": 1 },
            "default": {},
            "equals": {},
            "not_equals": {},
            "in": { "type": "array" },
            "not_in": { "type": "array" },
            "exists": { "type": "boolean" },
            "truthy": { "type": "boolean" }
          }
        },
        "expr": {
          "oneOf": [
            { "$ref": "#/$defs/expr_literal" },
            { "$ref": "#/$defs/expr_path" },
            { "$ref": "#/$defs/expr_concat" },
            { "$ref": "#/$defs/expr_coalesce" },
            { "$ref": "#/$defs/expr_number_format" }
          ]
        },
        "expr_literal": {
          "type": "object",
          "required": ["op", "value"],
          "additionalProperties": false,
          "properties": {
            "op": { "const": "literal" },
            "value": { "type": ["string", "number", "boolean", "null"] }
          }
        },
        "expr_path": {
          "type": "object",
          "required": ["op", "path"],
          "additionalProperties": false,
          "properties": {
            "op": { "const": "path" },
            "path": { "type": "string", "minLength": 1 },
            "default": {}
          }
        },
        "expr_concat": {
          "type": "object",
          "required": ["op", "args"],
          "additionalProperties": false,
          "properties": {
            "op": { "const": "concat" },
            "args": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/expr" } }
          }
        },
        "expr_coalesce": {
          "type": "object",
          "required": ["op", "args"],
          "additionalProperties": false,
          "properties": {
            "op": { "const": "coalesce" },
            "args": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/expr" } }
          }
        },
        "expr_number_format": {
          "type": "object",
          "required": ["op", "value"],
          "additionalProperties": false,
          "properties": {
            "op": { "const": "number_format" },
            "value": { "$ref": "#/$defs/expr" },
            "decimals": { "type": "integer", "minimum": 0, "maximum": 6 },
            "trim_trailing_zeros": { "type": "boolean" }
          }
        },
        "asset": {
          "type": "object",
          "required": ["name", "path"],
          "additionalProperties": false,
          "properties": {
            "name": { "type": "string", "minLength": 1 },
            "path": { "type": "string", "minLength": 1 },
            "content_type": { "type": "string" }
          }
        },
        "page": {
          "type": "object",
          "additionalProperties": false,
          "required": ["width_inch", "height_inch"],
          "properties": {
            "width_inch":  { "type": "number", "minimum": 1 },
            "height_inch": { "type": "number", "minimum": 1 },
            "margin_inch": { "type": "number", "minimum": 0 },
            "dpi":         { "type": "number", "minimum": 72 },
            "orientation": { "type": "string", "enum": ["portrait", "landscape"] }
          }
        },
        "template": {
          "type": "object",
          "required": ["version", "page", "blocks"],
          "additionalProperties": false,
          "properties": {
            "version": { "type": "string", "minLength": 1 },
            "template_key": { "type": "string" },
            "label_type": { "type": "string" },
            "variant_key": { "type": "string" },
            "print_profile_key": { "type": "string" },
            "page": { "$ref": "#/$defs/page" },
            "assets": { "type": "array", "items": { "$ref": "#/$defs/asset" }, "default": [] },
            "blocks": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/block" } },
            "barcode": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "type": { "type": "string" },
                "value_path": { "type": "string" },
                "human_readable": { "type": "string" }
              }
            },
            "max_attempts": { "type": "integer", "minimum": 1 },
            "retry_backoff_seconds": { "type": "array", "items": { "type": "integer", "minimum": 0 } },
            "metadata": { "type": "object" }
          }
        },
        "block_common": {
          "type": "object",
          "required": ["type", "x", "y"],
          "properties": {
            "id": { "type": "string", "minLength": 1, "maxLength": 80 },
            "type": { "type": "string" },
            "x": { "type": "number" },
            "y": { "type": "number" },
            "width": { "type": "number" },
            "height": { "type": "number" },
            "max_width": { "type": "number" },
            "max_height": { "type": "number" },
            "align": { "type": "string", "enum": ["left", "center", "right"] },
            "rotation": { "type": "number" },
            "color": { "$ref": "#/$defs/color" },
            "fill_color": { "$ref": "#/$defs/color" },
            "stroke_width": { "type": "number", "minimum": 0 }
          }
        },
        "block_text": {
          "allOf": [
            { "$ref": "#/$defs/block_common" },
            {
              "type": "object",
              "required": ["type"],
              "properties": {
                "type": { "const": "text" },
                "font": { "type": "string" },
                "font_size": { "type": "number", "exclusiveMinimum": 0 },
                "min_font_size": { "type": "number", "exclusiveMinimum": 0 },
                "hard_min_font_size": { "type": "number", "exclusiveMinimum": 0 },
                "wrap": { "type": "boolean" },
                "text_overflow": { "type": "string" },
                "line_height_factor": { "type": "number", "minimum": 0.8, "maximum": 2.5 },
                "valign": { "type": "string", "enum": ["top", "middle", "bottom"] },
                "baseline_descent_factor": { "type": "number", "minimum": 0, "maximum": 1 },
                "value_path": { "type": "string" },
                "fallback": { "type": "string" },
                "text_expr": { "$ref": "#/$defs/expr" },
                "render_if": {
                  "oneOf": [
                    { "$ref": "#/$defs/render_condition" },
                    { "type": "array", "items": { "$ref": "#/$defs/render_condition" } }
                  ]
                }
              },
              "anyOf": [
                { "required": ["value_path"] },
                { "required": ["text_expr"] },
                { "required": ["fallback"] }
              ]
            }
          ]
        },
        "block_barcode": {
          "allOf": [
            { "$ref": "#/$defs/block_common" },
            {
              "type": "object",
              "required": ["type", "value_path"],
              "properties": {
                "type": { "const": "barcode" },
                "barcode_type": { "type": "string", "enum": ["code128", "qr"] },
                "value_path": { "type": "string", "minLength": 1 },
                "fallback": { "type": "string" },
                "module_width": { "type": "number", "exclusiveMinimum": 0 },
                "max_scale": { "type": "number", "exclusiveMinimum": 0 },
                "reserve_bottom": { "type": "number", "minimum": 0 },
                "human_readable": { "type": "boolean" },
                "render_if": {
                  "oneOf": [
                    { "$ref": "#/$defs/render_condition" },
                    { "type": "array", "items": { "$ref": "#/$defs/render_condition" } }
                  ]
                }
              }
            }
          ]
        },
        "block_image": {
          "allOf": [
            { "$ref": "#/$defs/block_common" },
            {
              "type": "object",
              "required": ["type"],
              "properties": {
                "type": { "const": "image" },
                "asset_ref": { "type": "string" },
                "value_path": { "type": "string" },
                "allow_upscale": { "type": "boolean" },
                "max_scale": { "type": "number", "exclusiveMinimum": 0 },
                "render_if": {
                  "oneOf": [
                    { "$ref": "#/$defs/render_condition" },
                    { "type": "array", "items": { "$ref": "#/$defs/render_condition" } }
                  ]
                }
              },
              "anyOf": [
                { "required": ["asset_ref"] },
                { "required": ["value_path"] }
              ]
            }
          ]
        },
        "block_rect": {
          "allOf": [
            { "$ref": "#/$defs/block_common" },
            {
              "type": "object",
              "required": ["type", "width", "height"],
              "properties": {
                "type": { "const": "rect" },
                "render_if": {
                  "oneOf": [
                    { "$ref": "#/$defs/render_condition" },
                    { "type": "array", "items": { "$ref": "#/$defs/render_condition" } }
                  ]
                }
              }
            }
          ]
        },
        "block_line": {
          "allOf": [
            { "$ref": "#/$defs/block_common" },
            {
              "type": "object",
              "required": ["type"],
              "properties": {
                "type": { "const": "line" },
                "x2": { "type": "number" },
                "y2": { "type": "number" },
                "render_if": {
                  "oneOf": [
                    { "$ref": "#/$defs/render_condition" },
                    { "type": "array", "items": { "$ref": "#/$defs/render_condition" } }
                  ]
                }
              },
              "anyOf": [
                { "required": ["x2", "y2"] },
                { "required": ["width", "height"] }
              ]
            }
          ]
        },
        "block": {
          "oneOf": [
            { "$ref": "#/$defs/block_text" },
            { "$ref": "#/$defs/block_barcode" },
            { "$ref": "#/$defs/block_image" },
            { "$ref": "#/$defs/block_rect" },
            { "$ref": "#/$defs/block_line" }
          ]
        }
      }
    }
    $$::jsonb AS schema_doc,
    $$[
      {
        "version": "2025-12-30",
        "templates": {
          "shipping": {
            "version": "1.0.0",
            "template_key": "shipping_default_203dpi",
            "label_type": "shipping",
            "print_profile_key": "default_203dpi",
            "page": { "width_inch": 4, "height_inch": 6, "dpi": 203, "orientation": "portrait" },
            "assets": [{ "name": "logo", "path": "global/v1/logo.png", "content_type": "image/png" }],
            "blocks": [
              { "id": "hdr", "type": "rect", "x": 12, "y": 420, "width": 264, "height": 60, "fill_color": "#FFFFFF", "color": "#000000", "stroke_width": 1 },
              { "id": "tracking", "type": "text", "x": 18, "y": 455, "font": "Helvetica-Bold", "font_size": 18, "text_expr": { "op": "concat", "args": [
                { "op": "literal", "value": "Tracking: " },
                { "op": "path", "path": "tracking_number", "default": "" }
              ] } },
              { "id": "code128", "type": "barcode", "barcode_type": "code128", "x": 18, "y": 300, "width": 260, "height": 90, "value_path": "tracking_number" },
              { "id": "qr", "type": "barcode", "barcode_type": "qr", "x": 240, "y": 210, "width": 60, "height": 60, "value_path": "tracking_number" }
            ]
          }
        }
      }
    ]$$::jsonb AS examples,
    'label_design schema (v4: expression AST + QR + line blocks; backward compatible superset)'::text AS description
)
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active, created_at)
SELECT
  'label_design',
  4,
  contract.schema_doc,
  contract.description,
  contract.examples,
  TRUE,
  workflow_now()
FROM contract
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  created_at = workflow_now();

UPDATE public.schema_registry
SET is_active = CASE WHEN version = 4 THEN TRUE ELSE FALSE END
WHERE category = 'label_design';

-- Keep settings_versions aligned to the active schema (no content rewrite).
UPDATE public.settings_versions
SET schema_version = 4
WHERE category = 'label_design'
  AND schema_version IS DISTINCT FROM 4;

COMMIT;
