-- Migration: Seed masarx_waybill_v1 v1.8.1 from compiled geometry
-- Purpose: Insert immutable renderer_config snapshot, seed sections/tokens, and keep ladder compliance.

BEGIN;

SET search_path TO public, pg_temp;

INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'Global', 'global-root')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_org CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  v_payload JSONB := $json$
{
  "version": "2025-12-13",
  "templates": {
    "shipping": {
      "version": "1.8.1",
      "template_key": "masarx_waybill_v1",
      "label_type": "shipping",
      "page": {
        "width_inch": 4,
        "height_inch": 6,
        "margin_inch": 0.12,
        "dpi": 203,
        "orientation": "portrait"
      },
      "assets": [
        {
          "name": "logo",
          "path": "masarx/logo.png",
          "content_type": "image/png"
        }
      ],
      "blocks": [
        {
          "type": "line",
          "x": 14.19,
          "y": 384.4,
          "width": 273.82,
          "height": 384.4,
          "stroke_width": 1.5,
          "color": "#000000"
        },
        {
          "type": "line",
          "x": 14.19,
          "y": 315.95,
          "width": 273.82,
          "height": 315.95,
          "stroke_width": 1.5,
          "color": "#000000"
        },
        {
          "type": "line",
          "x": 14.19,
          "y": 234.52,
          "width": 273.82,
          "height": 234.52,
          "stroke_width": 1.5,
          "color": "#000000"
        },
        {
          "type": "line",
          "x": 14.19,
          "y": 141.03,
          "width": 273.82,
          "height": 141.03,
          "stroke_width": 1.5,
          "color": "#000000"
        },
        {
          "type": "line",
          "x": 14.19,
          "y": 77.54,
          "width": 273.82,
          "height": 77.54,
          "stroke_width": 1,
          "color": "#000000"
        },
        {
          "type": "line",
          "x": 14.19,
          "y": 21.15,
          "width": 273.82,
          "height": 21.15,
          "stroke_width": 1,
          "color": "#000000"
        },
        {
          "type": "line",
          "x": 100.73,
          "y": 77.54,
          "width": 100.73,
          "height": 141.03,
          "stroke_width": 1,
          "color": "#000000",
          "section_key": "refs_cod"
        },
        {
          "type": "line",
          "x": 187.27,
          "y": 77.54,
          "width": 187.27,
          "height": 141.03,
          "stroke_width": 1,
          "color": "#000000",
          "section_key": "refs_cod"
        },
        {
          "type": "line",
          "x": 100.73,
          "y": 21.15,
          "width": 100.73,
          "height": 77.54,
          "stroke_width": 1,
          "color": "#000000",
          "section_key": "bottom_table"
        },
        {
          "type": "line",
          "x": 187.27,
          "y": 21.15,
          "width": 187.27,
          "height": 77.54,
          "stroke_width": 1,
          "color": "#000000",
          "section_key": "bottom_table"
        },
        {
          "type": "image",
          "asset_ref": "logo",
          "x": 14.19,
          "y": 399.37,
          "width": 17.73,
          "height": 17.73,
          "section_key": "header"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 18,
          "color": "#2D3F90",
          "fallback": "MasarX",
          "max_width": 80,
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 36.18,
          "y": 398.66,
          "width": 31.26,
          "height": 19.15,
          "section_key": "header"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 18,
          "align": "right",
          "value_path": "payment_term_label",
          "fallback": "Prepaid",
          "max_width": 120,
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 273.81,
          "y": 402.5,
          "width": 48.2,
          "height": 15.32,
          "section_key": "header"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 10,
          "align": "right",
          "value_path": "created_at_local",
          "fallback": "",
          "max_width": 120,
          "valign": "bottom",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 273.81,
          "y": 395.05,
          "width": 48.2,
          "height": 7.45,
          "section_key": "header"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 18,
          "align": "right",
          "value_path": "service_level_label",
          "fallback": "Standard",
          "max_width": 120,
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 273.81,
          "y": 339.54,
          "width": 83.99,
          "height": 21.28,
          "section_key": "barcode_band"
        },
        {
          "type": "barcode",
          "value_path": "barcode_value",
          "fallback": "TRACKING",
          "human_readable": false,
          "module_width": 0.9,
          "max_scale": 5,
          "x": 14.19,
          "y": 326.59,
          "width": 158.61,
          "height": 47.17,
          "reserve_bottom": 13.58,
          "section_key": "barcode_band"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 11,
          "align": "center",
          "value_path": "tracking_number",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 93.48,
          "y": 326.59,
          "width": 55.99,
          "height": 9.58,
          "max_width": 156.61,
          "section_key": "barcode_band"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "fallback": "Sender",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 14.19,
          "y": 293.25,
          "width": 26.22,
          "height": 11.35,
          "max_width": 211.42,
          "section_key": "sender"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "align": "right",
          "value_path": "sender_phone",
          "fallback": "",
          "max_width": 120,
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 216.58,
          "y": 263.6,
          "width": 202.39,
          "height": 9.93,
          "section_key": "sender"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 12,
          "value_path": "sender_name",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 14.19,
          "y": 276.37,
          "width": 202.39,
          "height": 11.92,
          "max_width": 211.42,
          "section_key": "sender"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 10.5,
          "value_path": "origin_line1",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 14.19,
          "y": 253.67,
          "width": 202.39,
          "height": 9.93,
          "max_width": 211.42,
          "section_key": "sender"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 10,
          "value_path": "origin_summary",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 14.19,
          "y": 243.74,
          "width": 202.39,
          "height": 9.93,
          "max_width": 211.42,
          "section_key": "sender"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 32,
          "align": "right",
          "valign": "middle",
          "value_path": "destination_city_code",
          "fallback": "RIY",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 273.82,
          "y": 276.94,
          "width": 40.21,
          "height": 28.37,
          "section_key": "sender"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "fallback": "Receiver",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 14.19,
          "y": 213.24,
          "width": 31.23,
          "height": 11.35,
          "max_width": 211.42,
          "section_key": "receiver"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "align": "right",
          "value_path": "recipient_phone",
          "fallback": "",
          "max_width": 120,
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 216.58,
          "y": 183.59,
          "width": 202.39,
          "height": 9.93,
          "section_key": "receiver"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 12,
          "value_path": "recipient_name",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 14.19,
          "y": 196.36,
          "width": 202.39,
          "height": 11.92,
          "max_width": 211.42,
          "section_key": "receiver"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 10.5,
          "value_path": "destination_line1",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 14.19,
          "y": 173.66,
          "width": 202.39,
          "height": 9.93,
          "max_width": 211.42,
          "section_key": "receiver"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 10,
          "value_path": "destination_summary",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 14.19,
          "y": 160.89,
          "width": 202.39,
          "height": 9.93,
          "max_width": 211.42,
          "section_key": "receiver"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 32,
          "align": "right",
          "valign": "middle",
          "value_path": "destination_city_code",
          "fallback": "RIY",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 273.82,
          "y": 196.92,
          "width": 40.21,
          "height": 28.37,
          "section_key": "receiver"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "fallback": "Weight",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 19.86,
          "y": 123.65,
          "width": 73.77,
          "height": 11.7,
          "section_key": "refs_cod"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "align": "center",
          "fallback": "Reference Number",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 143.28,
          "y": 123.65,
          "width": 73.77,
          "height": 11.7,
          "section_key": "refs_cod"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "align": "right",
          "fallback": "COD",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 268.14,
          "y": 123.65,
          "width": 75.19,
          "height": 11.7,
          "section_key": "refs_cod"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 11,
          "align": "right",
          "value_path": "cod_label",
          "fallback": "0 SAR",
          "max_width": 60,
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 268.14,
          "y": 110.17,
          "width": 75.19,
          "height": 10.64,
          "section_key": "refs_cod"
        },
        {
          "type": "barcode",
          "align": "center",
          "value_path": "reference_number",
          "fallback": "",
          "human_readable": false,
          "module_width": 0.6,
          "max_scale": 5,
          "x": 143.28,
          "y": 91.02,
          "width": 73.77,
          "height": 28.37,
          "reserve_bottom": 0.58,
          "section_key": "refs_cod"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 9,
          "align": "center",
          "value_path": "reference_number",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 143.28,
          "y": 83.22,
          "width": 73.77,
          "height": 6.38,
          "max_width": 71.77,
          "section_key": "refs_cod"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "fallback": "Bundle",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 19.86,
          "y": 59.81,
          "width": 73.77,
          "height": 10.64,
          "section_key": "bottom_table"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "align": "center",
          "fallback": "Item List",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 143.28,
          "y": 58.74,
          "width": 73.77,
          "height": 11.7,
          "section_key": "bottom_table"
        },
        {
          "type": "text",
          "font": "Helvetica-Bold",
          "font_size": 11,
          "align": "right",
          "fallback": "Notes",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 268.14,
          "y": 58.74,
          "width": 75.19,
          "height": 11.7,
          "section_key": "bottom_table"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 10,
          "value_path": "bundle_label",
          "fallback": "1",
          "max_width": 60,
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 19.86,
          "y": 42.07,
          "width": 73.77,
          "height": 14.9,
          "section_key": "bottom_table"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 10,
          "align": "center",
          "fallback": ":Content",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 143.28,
          "y": 47.39,
          "width": 73.77,
          "height": 8.51,
          "max_width": 71.77,
          "section_key": "bottom_table"
        },
        {
          "type": "text",
          "font": "Helvetica",
          "font_size": 10,
          "align": "center",
          "value_path": "shipment_metadata.notes",
          "fallback": "",
          "valign": "top",
          "min_font_size": 6,
          "text_overflow": "shrink",
          "x": 143.28,
          "y": 26.82,
          "width": 73.77,
          "height": 19.15,
          "max_width": 71.77,
          "section_key": "bottom_table"
        }
      ],
      "barcode": {
        "type": "CODE128",
        "value_path": "barcode_value",
        "human_readable": false
      },
      "max_attempts": 5,
      "retry_backoff_seconds": [
        45,
        180,
        600
      ],
      "metadata": {
        "brand_name": "MasarX",
        "primary_color": "#2D3F90",
        "fallback_title": "MasarX Waybill",
        "description": "MasarX 4x6 waybill v1.7.8 tuned from Figma SSOT geometry"
      }
    }
  }
}
$json$::jsonb;
  v_tpl JSONB := v_payload -> 'templates' -> 'shipping';
  v_template_id UUID;
BEGIN
  INSERT INTO label_template_specs (
    organization_id, template_key, version, template_scope_type, template_scope_id, renderer_config, asset_refs
  )
  VALUES (
    v_org,
    'masarx_waybill_v1',
    181,
    'global',
    NULL,
    v_tpl,
    v_tpl -> 'assets'
  )
  ON CONFLICT (organization_id, template_key, version) DO NOTHING
  RETURNING id INTO v_template_id;

  IF v_template_id IS NULL THEN
    SELECT id INTO v_template_id
    FROM label_template_specs
    WHERE organization_id = v_org
      AND template_key = 'masarx_waybill_v1'
      AND version = 181
    LIMIT 1;
  END IF;

  INSERT INTO label_sections (
    organization_id, template_id, section_key, x, y, width, height,
    padding_top, padding_right, padding_bottom, padding_left, z_index
  )
  SELECT v_org, v_template_id, s.section_key, s.x, s.y, s.width, s.height,
         s.padding_top, s.padding_right, s.padding_bottom, s.padding_left, s.z_index
  FROM (VALUES
    ('header', 14.19, 395.05, 259.63, 22.77, 0, 0, 0, 0, 0),
    ('barcode_band', 14.19, 326.59, 259.63, 47.17, 0, 0, 0, 0, 1),
    ('sender', 14.19, 243.74, 259.63, 61.57, 0, 0, 0, 0, 2),
    ('receiver', 14.19, 150.96, 259.63, 74.34, 0, 0, 0, 0, 3),
    ('refs_cod', 14.19, 77.54, 259.63, 63.49, 0, 0, 0, 0, 4),
    ('bottom_table', 14.19, 21.15, 259.63, 56.39, 0, 0, 0, 0, 5)
  ) AS s(section_key, x, y, width, height, padding_top, padding_right, padding_bottom, padding_left, z_index)
  ON CONFLICT (template_id, organization_id, section_key) DO NOTHING;

  INSERT INTO label_design_tokens (organization_id, template_id, token_key, token_type, value)
  SELECT v_org, v_template_id, t.token_key, t.token_type, t.value::jsonb
  FROM (VALUES
    ('min_font_size', 'font_size', '9'),
    ('font_size_xs', 'font_size', '9'),
    ('font_size_sm', 'font_size', '10'),
    ('font_size_md', 'font_size', '11'),
    ('font_size_lg', 'font_size', '12'),
    ('font_size_xl', 'font_size', '18'),
    ('font_size_city', 'font_size', '32'),
    ('pad_xs', 'spacing', '4'),
    ('pad_sm', 'spacing', '6'),
    ('pad_md', 'spacing', '8'),
    ('pad_lg', 'spacing', '10'),
    ('band_height_barcode', 'band_height', '92'),
    ('header_height', 'band_height', '52'),
    ('table_row_height', 'spacing', '18'),
    ('column_divider_x1', 'spacing', '88'),
    ('column_divider_x2', 'spacing', '176'),
    ('barcode_min_height', 'barcode_min_height', '34'),
    ('barcode_min_module_width', 'barcode_min_width', '0.9'),
    ('barcode_min_height_ref', 'barcode_min_height', '22'),
    ('barcode_min_module_width_ref', 'barcode_min_width', '0.5'),
    ('logo_height', 'spacing', '16'),
    ('city_code_max_width', 'spacing', '80'),
    ('barcode_band_width', 'spacing', '232')
  ) AS t(token_key, token_type, value)
  ON CONFLICT (template_id, organization_id, token_key) DO NOTHING;
  

  -- Upsert renderer defaults (global)
  WITH upsert_global AS (
    INSERT INTO settings_versions (
      id, category, scope_type, scope_id, scope_hash, version, value, schema_version,
      change_reason, approved_at, effective_from, effective_until
    )
    SELECT
      COALESCE(
        (SELECT id FROM settings_versions WHERE category = 'label_design' AND scope_type = 'global' AND scope_id IS NULL ORDER BY approved_at DESC LIMIT 1),
        '77770000-0000-0000-0000-000000000310'::uuid
      ),
      'label_design',
      'global',
      NULL,
      '00000000-0000-0000-0000-000000000000'::uuid,
      COALESCE(
        (SELECT max(version) + 1 FROM settings_versions WHERE category = 'label_design' AND scope_type = 'global' AND scope_id IS NULL),
        1
      ),
      v_payload,
      2,
      'MasarX waybill v1.8.1 (auto-fit text, no ellipsis)',
      now(),
      now(),
      NULL
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET value = EXCLUDED.value,
        schema_version = EXCLUDED.schema_version,
        change_reason = EXCLUDED.change_reason,
        approved_at = EXCLUDED.approved_at,
        effective_from = EXCLUDED.effective_from,
        effective_until = EXCLUDED.effective_until
    RETURNING id, value
  )
  INSERT INTO settings (
    id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
  )
  SELECT
    '66660000-0000-0000-0000-000000000310'::uuid,
    'label_design',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    upsert_global.id,
    upsert_global.value,
    now()
  FROM upsert_global
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;


END $$;

COMMIT;
