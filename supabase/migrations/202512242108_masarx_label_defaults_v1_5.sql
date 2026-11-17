-- Migration: MasarX waybill template v1.5.0 (guarded layout)
-- Purpose: Finalize collision-free defaults with bounded barcodes and isolated ref row.

BEGIN;

SET search_path TO public, pg_temp;

WITH config AS (
  SELECT $json$
{
  "version": "2025-12-15",
  "templates": {
    "shipping": {
      "version": "1.5.0",
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
          "path": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZElEQVR42u3QQREAAAgDoPVPsaaaw5MHBUjb+SwCBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIEDAfQvU5fKkz4HjyQAAAABJRU5ErkJggg==",
          "content_type": "image/png"
        }
      ],
      "blocks": [
        { "type": "rect", "x": 10, "y": 388, "width": 268, "height": 42, "stroke_width": 1 },
        { "type": "image", "asset_ref": "logo", "x": 16, "y": 398, "width": 24, "height": 14 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 18, "x": 270, "y": 408, "align": "right", "value_path": "payment_term_label", "fallback": "Prepaid", "max_width": 120 },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 270, "y": 394, "align": "right", "value_path": "created_at_local", "fallback": "", "max_width": 120 },

        { "type": "rect", "x": 10, "y": 246, "width": 268, "height": 136, "stroke_width": 1 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 16, "x": 144, "y": 366, "align": "center", "value_path": "service_level_label", "fallback": "delivery", "max_width": 200 },
        { "type": "barcode", "x": 144, "y": 270, "height": 90, "module_width": 1.05, "max_width": 232, "align": "center", "value_path": "barcode_value", "fallback": "TRACKING", "human_readable": false },
        { "type": "text", "font": "Helvetica", "font_size": 12, "x": 144, "y": 252, "align": "center", "value_path": "tracking_number", "fallback": "", "max_width": 232 },

        { "type": "rect", "x": 10, "y": 188, "width": 268, "height": 52, "stroke_width": 1 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 16, "y": 228, "fallback": "Sender" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 270, "y": 228, "align": "right", "value_path": "sender_phone", "fallback": "", "max_width": 100 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 12, "x": 16, "y": 214, "value_path": "sender_name", "fallback": "", "max_width": 200 },
        { "type": "text", "font": "Helvetica", "font_size": 10.5, "x": 16, "y": 200, "value_path": "origin_line1", "fallback": "", "max_width": 220 },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 16, "y": 188, "value_path": "origin_summary", "fallback": "", "max_width": 220 },

        { "type": "rect", "x": 10, "y": 118, "width": 268, "height": 64, "stroke_width": 1 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 16, "y": 168, "fallback": "Receiver" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 270, "y": 168, "align": "right", "value_path": "recipient_phone", "fallback": "", "max_width": 100 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 12, "x": 16, "y": 154, "value_path": "recipient_name", "fallback": "", "max_width": 190 },
        { "type": "text", "font": "Helvetica", "font_size": 10.5, "x": 16, "y": 140, "value_path": "destination_line1", "fallback": "", "max_width": 190 },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 16, "y": 126, "value_path": "destination_summary", "fallback": "", "max_width": 190 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 30, "x": 268, "y": 136, "align": "right", "value_path": "destination_city_code", "fallback": "---", "max_width": 70 },

        { "type": "rect", "x": 10, "y": 52, "width": 268, "height": 60, "stroke_width": 1 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 16, "y": 100, "fallback": "Weight" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 144, "y": 100, "align": "center", "fallback": "Reference Number" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 268, "y": 100, "align": "right", "fallback": "COD" },
        { "type": "text", "font": "Helvetica", "font_size": 11, "x": 16, "y": 86, "value_path": "weight_label", "fallback": "--", "max_width": 80 },
        { "type": "text", "font": "Helvetica", "font_size": 11, "x": 268, "y": 86, "align": "right", "value_path": "cod_label", "fallback": "0 SAR", "max_width": 80 },
        { "type": "barcode", "x": 144, "y": 72, "height": 20, "module_width": 0.45, "max_width": 120, "align": "center", "value_path": "reference_number", "fallback": "", "human_readable": false },
        { "type": "text", "font": "Helvetica", "font_size": 9, "x": 144, "y": 58, "align": "center", "value_path": "reference_number", "fallback": "", "max_width": 120 },

        { "type": "rect", "x": 10, "y": 10, "width": 268, "height": 36, "stroke_width": 1 },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 16, "y": 32, "fallback": "Bundle" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 144, "y": 32, "align": "center", "fallback": "Item List" },
        { "type": "text", "font": "Helvetica-Bold", "font_size": 11, "x": 268, "y": 32, "align": "right", "fallback": "Notes" },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 16, "y": 18, "value_path": "bundle_label", "fallback": "1", "max_width": 50 },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 144, "y": 18, "align": "center", "value_path": "shipment_metadata", "fallback": "", "max_width": 110 },
        { "type": "text", "font": "Helvetica", "font_size": 10, "x": 268, "y": 18, "align": "right", "value_path": "special_instructions", "fallback": "", "max_width": 70 }
      ],
      "barcode": {
        "type": "CODE128",
        "value_path": "barcode_value",
        "human_readable": "tracking_number"
      },
      "max_attempts": 5,
      "retry_backoff_seconds": [45, 180, 600],
      "metadata": {
        "brand_name": "MasarX",
        "primary_color": "#2D3F90",
        "fallback_title": "MasarX Waybill",
        "description": "MasarX 4x6 waybill v1.5.0 with guarded spacing and ref barcode isolation"
      }
    }
  }
}
$json$::jsonb AS payload
), upsert_global AS (
  INSERT INTO settings_versions (
    id, category, scope_type, scope_id, scope_hash, version, value, schema_version,
    change_reason, approved_at, effective_from, effective_until
  )
  SELECT
    COALESCE(
      (SELECT id FROM settings_versions WHERE category = 'label_design' AND scope_type = 'global' AND scope_id IS NULL ORDER BY approved_at DESC LIMIT 1),
      '77770000-0000-0000-0000-000000000210'::uuid
    ) AS id,
    'label_design',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    16,
    config.payload,
    2,
    'Update MasarX waybill to v1.5.0 (guarded spacing + ref isolation)',
    now(),
    now(),
    NULL
  FROM config
  ON CONFLICT (id, scope_hash) DO UPDATE
  SET value = EXCLUDED.value,
      schema_version = EXCLUDED.schema_version,
      change_reason = EXCLUDED.change_reason,
      approved_at = EXCLUDED.approved_at,
      effective_from = EXCLUDED.effective_from,
      effective_until = EXCLUDED.effective_until
  RETURNING id, value
), apply_global AS (
  INSERT INTO settings (
    id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
  )
  SELECT
    '66660000-0000-0000-0000-000000000210'::uuid,
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
      last_updated = EXCLUDED.last_updated
), tenant_targets AS (
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
    ) AS id,
    'label_design',
    'tenant',
    t.scope_id,
    t.scope_id,
    14,
    config.payload,
    2,
    'Tenant label template upgrade to MasarX waybill v1.5.0 (guarded spacing + ref isolation)',
    now(),
    now(),
    NULL
  FROM tenant_targets t
  CROSS JOIN config
  ON CONFLICT (id, scope_hash) DO UPDATE
  SET value = EXCLUDED.value,
      schema_version = EXCLUDED.schema_version,
      change_reason = EXCLUDED.change_reason,
      approved_at = EXCLUDED.approved_at,
      effective_from = EXCLUDED.effective_from,
      effective_until = EXCLUDED.effective_until
  RETURNING id, scope_id, value
), apply_tenant AS (
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
      last_updated = EXCLUDED.last_updated
)
SELECT 'label_design v1.5.0 seeded' AS status;

COMMIT;
