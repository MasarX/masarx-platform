-- Migration: MasarX waybill template v1.2.0 (Code128 + production layout)
-- Purpose: Align default label layout to production waybill with Code128 barcodes, separators, and refined spacing.

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
    'version', '2025-12-01',
    'templates', jsonb_build_object(
      'shipping', jsonb_build_object(
        'version', '1.2.0',
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
          jsonb_build_object('type', 'image', 'asset_ref', 'logo', 'x', 16, 'y', 370, 'width', 54, 'height', 44),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 396, 'font', 'Helvetica-Bold', 'font_size', 16, 'align', 'right', 'value_path', 'payment_term_label', 'fallback', 'Prepaid'),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 378, 'font', 'Helvetica', 'font_size', 10, 'align', 'right', 'value_path', 'created_at_local', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 354, 'font', 'Helvetica-Bold', 'font_size', 18, 'align', 'right', 'value_path', 'service_level_label', 'fallback', 'Standard'),
          jsonb_build_object('type', 'barcode', 'x', 144, 'y', 300, 'height', 64, 'module_width', 1.2, 'align', 'center', 'value_path', 'barcode_value', 'fallback', 'TRACKING'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 270, 'font', 'Helvetica', 'font_size', 12, 'align', 'center', 'value_path', 'tracking_number', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 258, 'font', 'Helvetica', 'font_size', 9, 'align', 'center', 'fallback', repeat('_', 60)),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 244, 'font', 'Helvetica-Bold', 'font_size', 11, 'fallback', 'Sender'),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 244, 'font', 'Helvetica-Bold', 'font_size', 10, 'align', 'right', 'value_path', 'organization_name', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 228, 'font', 'Helvetica-Bold', 'font_size', 12, 'value_path', 'sender_name', 'fallback', 'Sender'),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 212, 'font', 'Helvetica', 'font_size', 11, 'value_path', 'origin_line1', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 198, 'font', 'Helvetica', 'font_size', 10, 'value_path', 'origin_summary', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 186, 'font', 'Helvetica', 'font_size', 9, 'align', 'center', 'fallback', repeat('_', 60)),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 172, 'font', 'Helvetica-Bold', 'font_size', 11, 'fallback', 'Receiver'),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 172, 'font', 'Helvetica-Bold', 'font_size', 10, 'align', 'right', 'value_path', 'recipient_phone', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 156, 'font', 'Helvetica-Bold', 'font_size', 12, 'value_path', 'recipient_name', 'fallback', 'Recipient'),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 140, 'font', 'Helvetica', 'font_size', 11, 'value_path', 'destination_line1', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 16, 'y', 126, 'font', 'Helvetica', 'font_size', 10, 'value_path', 'destination_summary', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 270, 'y', 146, 'font', 'Helvetica-Bold', 'font_size', 32, 'align', 'right', 'value_path', 'destination_city_code', 'fallback', '---'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 114, 'font', 'Helvetica', 'font_size', 9, 'align', 'center', 'fallback', repeat('_', 60)),
          jsonb_build_object('type', 'text', 'x', 20, 'y', 100, 'font', 'Helvetica-Bold', 'font_size', 11, 'fallback', 'Weight'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 100, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'center', 'fallback', 'Reference Number'),
          jsonb_build_object('type', 'text', 'x', 268, 'y', 100, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'right', 'fallback', 'COD'),
          jsonb_build_object('type', 'text', 'x', 20, 'y', 82, 'font', 'Helvetica', 'font_size', 11, 'value_path', 'weight_label', 'fallback', '--'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 82, 'font', 'Helvetica', 'font_size', 11, 'align', 'center', 'value_path', 'reference_number', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 268, 'y', 82, 'font', 'Helvetica', 'font_size', 11, 'align', 'right', 'value_path', 'cod_label', 'fallback', '0 SAR'),
          jsonb_build_object('type', 'barcode', 'x', 144, 'y', 54, 'height', 46, 'module_width', 1.0, 'align', 'center', 'value_path', 'reference_number', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 20, 'y', 38, 'font', 'Helvetica-Bold', 'font_size', 11, 'fallback', 'Bundle'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 38, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'center', 'fallback', 'Item List'),
          jsonb_build_object('type', 'text', 'x', 268, 'y', 38, 'font', 'Helvetica-Bold', 'font_size', 11, 'align', 'right', 'fallback', 'Notes'),
          jsonb_build_object('type', 'text', 'x', 20, 'y', 22, 'font', 'Helvetica', 'font_size', 11, 'value_path', 'bundle_label', 'fallback', '1'),
          jsonb_build_object('type', 'text', 'x', 144, 'y', 22, 'font', 'Helvetica', 'font_size', 11, 'align', 'center', 'value_path', 'shipment_metadata', 'fallback', ''),
          jsonb_build_object('type', 'text', 'x', 268, 'y', 22, 'font', 'Helvetica', 'font_size', 11, 'align', 'right', 'value_path', 'special_instructions', 'fallback', '')
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
          'description', 'Default MasarX 4x6 waybill with inline logo, Code128 barcodes, and production layout'
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
    4,
    config.payload,
    2,
    'Update MasarX waybill to v1.2 (Code128, separators, refined layout)',
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
    2,
    config.payload,
    2,
    'Tenant label template upgrade to MasarX waybill v1.2',
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
SELECT 1;

COMMIT;
