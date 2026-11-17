-- Migration: MasarX waybill template v1.3.0 (layout aligned to provided production reference)
-- Purpose: Tighten block positions (headers, barcodes, sender/receiver panels, weight row, bundle row) to match the supplied sample label.

BEGIN;

SET search_path TO public, pg_temp;

WITH current_global AS (
  SELECT value
  FROM settings_versions
  WHERE category = 'label_design'
    AND scope_type = 'global'
  ORDER BY approved_at DESC
  LIMIT 1
),
logo AS (
  SELECT COALESCE(
    (SELECT value -> 'templates' -> 'shipping' -> 'assets' -> 0 ->> 'path' FROM current_global),
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZElEQVR42u3QQREAAAgDoPVPsaaaw5MHBUjb+SwCBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIEDAfQvU5fKkz4HjyQAAAABJRU5ErkJggg=='
  ) AS data_url
),
config AS (
  SELECT jsonb_build_object(
    'version', '2025-12-02',
    'templates', jsonb_build_object(
      'shipping', jsonb_build_object(
        'version', '1.3.0',
        'template_key', 'masarx_waybill_v1',
        'label_type', 'shipping',
        'page', jsonb_build_object(
          'width_inch', 4,
          'height_inch', 6,
          'margin_inch', 0.12,
          'dpi', 203,
          'orientation', 'portrait'
        ),
        'assets', jsonb_build_array(
          jsonb_build_object(
            'name', 'logo',
            'path', logo.data_url,
            'content_type', 'image/png'
          )
        ),
        'blocks', jsonb_build_array(
          jsonb_build_object('type', 'image', 'asset_ref', 'logo', 'x', 16, 'y', 398, 'width', 46, 'height', 36),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 410, 'font', 'Helvetica-Bold', 'font_size', 18, 'align', 'right', 'value_path', 'payment_term_label', 'fallback', 'Prepaid'),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 392, 'font', 'Helvetica', 'font_size', 10, 'align', 'right', 'value_path', 'created_at_local', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 360, 'font', 'Helvetica-Bold', 'font_size', 18, 'align', 'right', 'value_path', 'service_level_label', 'fallback', 'Standard'),
          jsonb_build_object('type', 'barcode', 'x', 144, 'y', 276, 'height', 82, 'module_width', 1.05, 'align', 'center', 'value_path', 'barcode_value', 'fallback', 'TRACKING'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 240, 'font', 'Helvetica', 'font_size', 12, 'align', 'center', 'value_path', 'tracking_number', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 226, 'font', 'Helvetica', 'font_size', 9, 'align', 'center', 'fallback', repeat('_', 70)),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 210, 'font', 'Helvetica-Bold', 'font_size', 11, 'fallback', 'Sender'),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 210, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'right', 'value_path', 'sender_phone', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 194, 'font', 'Helvetica-Bold', 'font_size', 12, 'value_path', 'sender_name', 'fallback', 'Sender'),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 178, 'font', 'Helvetica', 'font_size', 11, 'value_path', 'origin_line1', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 164, 'font', 'Helvetica', 'font_size', 10, 'value_path', 'origin_summary', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 152, 'font', 'Helvetica', 'font_size', 9, 'align', 'center', 'fallback', repeat('_', 70)),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 136, 'font', 'Helvetica-Bold', 'font_size', 11, 'fallback', 'Receiver'),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 136, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'right', 'value_path', 'recipient_phone', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 120, 'font', 'Helvetica-Bold', 'font_size', 12, 'value_path', 'recipient_name', 'fallback', 'Recipient'),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 104, 'font', 'Helvetica', 'font_size', 11, 'value_path', 'destination_line1', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 90, 'font', 'Helvetica', 'font_size', 10, 'value_path', 'destination_summary', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 150, 'font', 'Helvetica-Bold', 'font_size', 32, 'align', 'right', 'value_path', 'destination_city_code', 'fallback', '---'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 134, 'font', 'Helvetica', 'font_size', 9, 'align', 'center', 'fallback', repeat('_', 70)),
          jsonb_build_object('type', 'text', 'x', 20, 'y', 120, 'font', 'Helvetica-Bold', 'font_size', 11, 'fallback', 'Weight'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 120, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'center', 'fallback', 'Reference Number'),
          jsonb_build_object('type', 'text', 'x', 268, 'y', 120, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'right', 'fallback', 'COD'),
          jsonb_build_object('type', 'text', 'x', 20, 'y', 104, 'font', 'Helvetica', 'font_size', 11, 'value_path', 'weight_label', 'fallback', '--'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 104, 'font', 'Helvetica', 'font_size', 11, 'align', 'center', 'value_path', 'reference_number', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 268, 'y', 104, 'font', 'Helvetica', 'font_size', 11, 'align', 'right', 'value_path', 'cod_label', 'fallback', '0 SAR'),
          jsonb_build_object('type', 'barcode', 'x', 144, 'y', 60, 'height', 30, 'module_width', 1.0, 'align', 'center', 'font_size', 9, 'value_path', 'reference_number', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 20, 'y', 32, 'font', 'Helvetica-Bold', 'font_size', 11, 'fallback', 'Bundle'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 32, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'center', 'fallback', 'Item List'),
          jsonb_build_object('type', 'text', 'x', 268, 'y', 32, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'right', 'fallback', 'Notes'),
          jsonb_build_object('type', 'text', 'x', 20, 'y', 16, 'font', 'Helvetica', 'font_size', 11, 'value_path', 'bundle_label', 'fallback', '1'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 16, 'font', 'Helvetica', 'font_size', 11, 'align', 'center', 'value_path', 'shipment_metadata', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 268, 'y', 16, 'font', 'Helvetica', 'font_size', 11, 'align', 'right', 'value_path', 'special_instructions', 'fallback', '')
        ),
        'barcode', jsonb_build_object(
          'type', 'CODE128',
          'value_path', 'barcode_value',
          'human_readable', 'tracking_number'
        ),
        'max_attempts', 5,
        'retry_backoff_seconds', jsonb_build_array(45, 180, 600),
        'metadata', jsonb_build_object(
          'brand_name', 'MasarX',
          'primary_color', '#2D3F90',
          'fallback_title', 'MasarX Waybill',
          'description', 'MasarX 4x6 waybill v1.3.0 with reference-parity spacing and Code128 bars'
        )
      )
    )
  ) AS payload
  FROM logo
)
, upsert_global AS (
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
    6,
    config.payload,
    2,
    'Update MasarX waybill to v1.3.0 (layout parity with provided reference)',
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
    4,
    config.payload,
    2,
    'Tenant label template upgrade to MasarX waybill v1.3.0 (reference-aligned)',
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
), tenant_apply AS (
  INSERT INTO settings (
    id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
  )
  SELECT
    gen_random_uuid(),
    'label_design',
    'tenant',
    tv.scope_id,
    tv.scope_id,
    tv.id,
    tv.value,
    now()
  FROM tenant_versions tv
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated
)
SELECT 'label_design v1.3.0 seeded' AS status;

COMMIT;
