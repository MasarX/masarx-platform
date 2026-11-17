-- Migration: MasarX waybill v1.6.1 (section width fix)
-- Purpose: Seed v1.6.1 with section widths spanning the page (to support right-aligned blocks) and slightly taller header.
-- Alignment: Append-only; keep prior versions intact; update defaults to prefer v1.6.1.

BEGIN;

SET search_path TO public, pg_temp;

-- Ensure sentinel global organization exists
INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'Global', 'global-root')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_org CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  v_payload JSONB := $json$
{
  "version": "2025-12-21",
  "templates": {
    "shipping": {
      "version": "1.6.1",
      "template_key": "masarx_waybill_v1",
      "label_type": "shipping",
      "page": { "width_inch": 4, "height_inch": 6, "margin_inch": 0.12, "dpi": 203, "orientation": "portrait" },
      "assets": [{ "name": "logo", "path": "masarx/logo.png", "content_type": "image/png" }],
      "blocks": [
        { "type": "rect", "x": 12, "y": 374, "width": 264, "height": 52, "stroke_width": 1, "section_key": "header" },
        { "type": "image", "asset_ref": "logo", "x": 18, "y": 392, "width": 26, "height": 16, "section_key": "header" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 18, "x": 274, "y": 410, "width": 120, "height": 18, "align": "right", "value_path": "payment_term_label", "fallback": "Prepaid", "max_width": 120, "section_key": "header" },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 274, "y": 394, "width": 120, "height": 12, "align": "right", "value_path": "created_at_local", "fallback": "", "max_width": 120, "section_key": "header" },

        { "type": "rect", "x": 12, "y": 282, "width": 264, "height": 92, "stroke_width": 1, "section_key": "barcode_band" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 18, "x": 270, "y": 352, "width": 120, "height": 16, "align": "right", "value_path": "service_level_label", "fallback": "Standard", "max_width": 120, "section_key": "barcode_band" },
        { "type": "barcode", "x": 144, "y": 300, "width": 232, "height": 34, "module_width": 0.9, "max_width": 232, "align": "center", "value_path": "barcode_value", "fallback": "TRACKING", "human_readable": false, "section_key": "barcode_band" },
        { "type": "text", "font": "Helvetica", "font_size": 11, "x": 144, "y": 286, "width": 232, "height": 12, "align": "center", "value_path": "tracking_number", "fallback": "", "max_width": 232, "section_key": "barcode_band" },

        { "type": "rect", "x": 12, "y": 212, "width": 264, "height": 70, "stroke_width": 1, "section_key": "sender" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 18, "y": 264, "width": 130, "height": 12, "fallback": "Sender", "section_key": "sender" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 272, "y": 264, "width": 120, "height": 12, "align": "right", "value_path": "sender_phone", "fallback": "", "max_width": 120, "section_key": "sender" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 12, "x": 18, "y": 248, "width": 230, "height": 14, "value_path": "sender_name", "fallback": "", "max_width": 230, "section_key": "sender" },
        { "type": "text", "font": "Helvetica", "font_size": 10.5, "x": 18, "y": 234, "width": 230, "height": 12, "value_path": "origin_line1", "fallback": "", "max_width": 230, "section_key": "sender" },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 18, "y": 220, "width": 230, "height": 11, "value_path": "origin_summary", "fallback": "", "max_width": 230, "section_key": "sender" },

        { "type": "rect", "x": 12, "y": 142, "width": 264, "height": 70, "stroke_width": 1, "section_key": "receiver" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 18, "y": 194, "width": 130, "height": 12, "fallback": "Receiver", "section_key": "receiver" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 272, "y": 194, "width": 120, "height": 12, "align": "right", "value_path": "recipient_phone", "fallback": "", "max_width": 120, "section_key": "receiver" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 12, "x": 18, "y": 178, "width": 170, "height": 14, "value_path": "recipient_name", "fallback": "", "max_width": 170, "section_key": "receiver" },
        { "type": "text", "font": "Helvetica", "font_size": 10.5, "x": 18, "y": 162, "width": 170, "height": 12, "value_path": "destination_line1", "fallback": "", "max_width": 170, "section_key": "receiver" },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 18, "y": 148, "width": 170, "height": 11, "value_path": "destination_summary", "fallback": "", "max_width": 170, "section_key": "receiver" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 32, "x": 272, "y": 156, "width": 80, "height": 32, "align": "right", "value_path": "destination_city_code", "fallback": "RIY", "max_width": 80, "section_key": "receiver" },

        { "type": "rect", "x": 12, "y": 92, "width": 264, "height": 50, "stroke_width": 1, "section_key": "refs_cod" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 18, "y": 130, "width": 60, "height": 12, "fallback": "Weight", "section_key": "refs_cod" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 152, "y": 130, "width": 120, "height": 12, "align": "center", "fallback": "Reference Number", "section_key": "refs_cod" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 276, "y": 130, "width": 60, "height": 12, "align": "right", "fallback": "COD", "section_key": "refs_cod" },
        { "type": "text", "font": "Helvetica", "font_size": 11, "x": 18, "y": 116, "width": 60, "height": 12, "value_path": "weight_label", "fallback": "--", "max_width": 60, "section_key": "refs_cod" },
        { "type": "text", "font": "Helvetica", "font_size": 11, "x": 276, "y": 116, "width": 60, "height": 12, "align": "right", "value_path": "cod_label", "fallback": "0 SAR", "max_width": 60, "section_key": "refs_cod" },
        { "type": "barcode", "x": 152, "y": 104, "width": 120, "height": 22, "module_width": 0.6, "max_width": 120, "align": "center", "value_path": "reference_number", "fallback": "", "human_readable": false, "section_key": "refs_cod" },
        { "type": "text", "font": "Helvetica", "font_size": 9, "x": 152, "y": 94, "width": 120, "height": 10, "align": "center", "value_path": "reference_number", "fallback": "", "max_width": 120, "section_key": "refs_cod" },

        { "type": "rect", "x": 12, "y": 36, "width": 264, "height": 56, "stroke_width": 1, "section_key": "bottom_table" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 18, "y": 74, "width": 60, "height": 12, "fallback": "Bundle", "section_key": "bottom_table" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 152, "y": 74, "width": 120, "height": 12, "align": "center", "fallback": "Item List", "section_key": "bottom_table" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 276, "y": 74, "width": 60, "height": 12, "align": "right", "fallback": "Notes", "section_key": "bottom_table" },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 18, "y": 58, "width": 60, "height": 12, "value_path": "bundle_label", "fallback": "1", "max_width": 60, "section_key": "bottom_table" },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 152, "y": 58, "width": 120, "height": 12, "align": "center", "value_path": "shipment_metadata", "fallback": "", "max_width": 120, "section_key": "bottom_table" },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 276, "y": 58, "width": 60, "height": 12, "align": "right", "value_path": "special_instructions", "fallback": "", "max_width": 60, "section_key": "bottom_table" }
      ],
      "barcode": { "type": "CODE128", "value_path": "barcode_value", "human_readable": "tracking_number" },
      "max_attempts": 5,
      "retry_backoff_seconds": [45, 180, 600],
      "metadata": { "brand_name": "MasarX", "primary_color": "#2D3F90", "fallback_title": "MasarX Waybill", "description": "MasarX 4x6 waybill v1.6.1 sectioned layout" }
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
    161,
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
      AND version = 161
    LIMIT 1;
  END IF;

  INSERT INTO label_sections (
    organization_id, template_id, section_key, x, y, width, height, padding_top, padding_right, padding_bottom, padding_left, z_index
  )
  SELECT v_org, v_template_id, s.section_key, s.x, s.y, s.width, s.height, s.pt, s.pr, s.pb, s.pl, s.z
  FROM (VALUES
    ('header', 0, 374, 288, 54, 0, 0, 0, 0, 0),
    ('barcode_band', 0, 282, 288, 92, 0, 0, 0, 0, 0),
    ('sender', 0, 212, 288, 70, 0, 0, 0, 0, 0),
    ('receiver', 0, 142, 288, 70, 0, 0, 0, 0, 0),
    ('refs_cod', 0, 92, 288, 50, 0, 0, 0, 0, 0),
    ('bottom_table', 0, 36, 288, 56, 0, 0, 0, 0, 0)
  ) AS s(section_key, x, y, width, height, pt, pr, pb, pl, z)
  ON CONFLICT (template_id, organization_id, section_key) DO NOTHING;

  INSERT INTO label_design_tokens (organization_id, template_id, token_key, token_type, value)
  SELECT v_org, v_template_id, tk, tt, tv::jsonb
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
    ('header_height', 'band_height', '54'),
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
  ) AS t(tk, tt, tv)
  ON CONFLICT (template_id, organization_id, token_key) DO NOTHING;

  -- Update defaults to prefer v1.6.1
  WITH upsert_global AS (
    INSERT INTO settings_versions (
      id, category, scope_type, scope_id, scope_hash, version, value, schema_version,
      change_reason, approved_at, effective_from, effective_until
    )
    SELECT
      COALESCE(
        (SELECT id FROM settings_versions WHERE category = 'label_design' AND scope_type = 'global' AND scope_id IS NULL ORDER BY approved_at DESC LIMIT 1),
        '77770000-0000-0000-0000-000000000311'::uuid
      ),
      'label_design',
      'global',
      NULL,
      '00000000-0000-0000-0000-000000000000'::uuid,
      20,
      v_payload,
      2,
      'MasarX waybill sectioned template v1.6.1',
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
    '66660000-0000-0000-0000-000000000311'::uuid,
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

  WITH tenant_targets AS (
    SELECT s.scope_id
    FROM settings s
    JOIN settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'label_design'
      AND s.scope_type = 'tenant'
      AND (s.cached_value -> 'templates' -> 'shipping' ->> 'template_key') = 'masarx_waybill_v1'
  ), tenant_versions AS (
    INSERT INTO settings_versions (
      id, category, scope_type, scope_id, scope_hash, version, value, schema_version,
      change_reason, approved_at, effective_from, effective_until
    )
    SELECT
      COALESCE(
        (SELECT id FROM settings_versions WHERE category = 'label_design' AND scope_type = 'tenant' AND scope_id = t.scope_id ORDER BY approved_at DESC LIMIT 1),
        uuid_from_hash(format('label_design:tenant:%s:masarx_waybill_v1', t.scope_id))
      ),
      'label_design',
      'tenant',
      t.scope_id,
      t.scope_id,
      18,
      v_payload,
      2,
      'Tenant label template upgrade to MasarX waybill v1.6.1 (section width fix)',
      now(),
      now(),
      NULL
    FROM tenant_targets t
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET value = EXCLUDED.value,
        schema_version = EXCLUDED.schema_version,
        change_reason = EXCLUDED.change_reason,
        approved_at = EXCLUDED.approved_at,
        effective_from = EXCLUDED.effective_from,
        effective_until = EXCLUDED.effective_until
    RETURNING id, scope_id, value
  )
  INSERT INTO settings (
    id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
  )
  SELECT
    uuid_from_hash(format('label_design:tenant:%s:current', t.scope_id)),
    'label_design',
    'tenant',
    t.scope_id,
    t.scope_id,
    t.id,
    t.value,
    now()
  FROM tenant_versions t
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END $$;

COMMIT;
