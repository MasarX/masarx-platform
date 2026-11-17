-- Migration: MasarX production label defaults and payload enrichments
-- Purpose: Enrich label payloads with derived fields and seed a MasarX-branded 4x6 default template (inline logo) plus renderer defaults.

BEGIN;

SET search_path TO public, pg_temp;

-- 1) Recreate label payload view with derived fields for rendering
DROP VIEW IF EXISTS shipment_label_payload_v;

CREATE VIEW shipment_label_payload_v AS
SELECT
    s.organization_id,
    org.name AS organization_name,
    s.client_id,
    c.name AS client_name,
    s.sender_id,
    snd.name AS sender_name,
    snd.brand_name AS sender_brand_name,
    s.id AS shipment_id,
    s.status AS shipment_status,
    s.tracking_number,
    s.carrier_reference_number,
    s.client_reference_number,
    s.service_type,
    s.cod_amount,
    s.cod_currency,
    s.declared_value,
    s.special_instructions,
    s.metadata AS shipment_metadata,
    s.created_at AS shipment_created_at,
    to_char(s.created_at AT TIME ZONE COALESCE(org.timezone, 'UTC'), 'YYYY-MM-DD HH24:MI:SS') AS created_at_local,
    sb.id AS shipment_box_id,
    sb.box_number,
    sb.barcode,
    sb.weight_kg,
    sb.length_cm,
    sb.width_cm,
    sb.height_cm,
    sb.volumetric_weight_kg,
    sb.fragile,
    sb.hazmat,
    r.id AS recipient_id,
    r.name AS recipient_name,
    r.phone_number AS recipient_phone,
    r.email AS recipient_email,
    r.preferred_language,
    dest.id AS destination_address_id,
    dest.raw_input AS destination_raw_input,
    dest.normalized_line1 AS destination_line1,
    dest.normalized_line2 AS destination_line2,
    dest.district AS destination_district,
    dest.city AS destination_city,
    dest.province AS destination_province,
    dest.postal_code AS destination_postal_code,
    dest.country AS destination_country,
    origin.id AS origin_address_id,
    origin.raw_input AS origin_raw_input,
    origin.normalized_line1 AS origin_line1,
    origin.normalized_line2 AS origin_line2,
    origin.city AS origin_city,
    origin.province AS origin_province,
    origin.country AS origin_country,
    COALESCE(NULLIF(s.service_type, ''), 'Standard') AS service_level_label,
    CASE WHEN COALESCE(s.cod_amount, 0) > 0 THEN 'COD' ELSE 'Prepaid' END AS payment_term_label,
    COALESCE(
      CASE WHEN s.cod_amount IS NOT NULL THEN concat(trim(to_char(s.cod_amount, 'FM999999990.##')), ' ', COALESCE(s.cod_currency, 'SAR')) END,
      concat('0 ', COALESCE(s.cod_currency, 'SAR'))
    ) AS cod_label,
    COALESCE(
      CASE WHEN sb.weight_kg IS NOT NULL THEN trim(to_char(sb.weight_kg, 'FM999990.##')) || ' kg' END,
      CASE WHEN sb.volumetric_weight_kg IS NOT NULL THEN trim(to_char(sb.volumetric_weight_kg, 'FM999990.##')) || ' kg (vol)' END
    ) AS weight_label,
    COALESCE(sb.barcode, s.tracking_number) AS barcode_value,
    COALESCE(s.client_reference_number, s.carrier_reference_number, s.tracking_number) AS reference_number,
    COALESCE(sb.box_number, 1) AS bundle_label,
    CASE WHEN dest.city IS NOT NULL THEN upper(substr(dest.city, 1, 3)) ELSE NULL END AS destination_city_code,
    concat_ws(', ', NULLIF(origin.city, ''), NULLIF(origin.province, ''), NULLIF(origin.country, '')) AS origin_summary,
    concat_ws(', ', NULLIF(dest.city, ''), NULLIF(dest.province, ''), NULLIF(dest.country, '')) AS destination_summary
FROM shipments s
LEFT JOIN organizations org ON org.id = s.organization_id
LEFT JOIN clients c ON c.id = s.client_id
LEFT JOIN senders snd ON snd.id = s.sender_id
LEFT JOIN shipment_boxes sb ON sb.shipment_id = s.id
LEFT JOIN recipients r ON r.id = s.recipient_id
LEFT JOIN addresses dest ON dest.id = s.destination_address_id
LEFT JOIN addresses origin ON origin.id = s.origin_address_id;

COMMENT ON VIEW shipment_label_payload_v IS 'Flattened payload combining shipments, boxes, recipients, addresses, and branding context for label rendering (with derived label-friendly fields).';

REVOKE ALL ON shipment_label_payload_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON shipment_label_payload_v TO label_renderer_role;
GRANT SELECT ON shipment_label_payload_v TO service_role;

-- 2) Seed MasarX-branded default template (inline logo) and renderer defaults
WITH logo AS (
  SELECT 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZElEQVR42u3QQREAAAgDoPVPsaaaw5MHBUjb+SwCBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIEDAfQvU5fKkz4HjyQAAAABJRU5ErkJggg=='::text AS data_url
), config AS (
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
), upsert_global AS (
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
    effective_from,
    effective_until
  )
  SELECT
    COALESCE(
      (
        SELECT id
        FROM settings_versions
        WHERE category = 'label_design'
          AND scope_type = 'global'
          AND scope_id IS NULL
        ORDER BY approved_at DESC
        LIMIT 1
      ),
      '77770000-0000-0000-0000-000000000210'::uuid
    ) AS id,
    'label_design',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    3,
    config.payload,
    2,
    'Seed MasarX waybill v1.1 default (inline logo, derived fields)',
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
), tenant_refresh AS (
  SELECT s.scope_id
  FROM settings s
  JOIN settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'label_design'
    AND s.scope_type = 'tenant'
    AND (s.cached_value -> 'templates' -> 'shipping' ->> 'template_key') = 'standard_4x6_v2'
), tenant_versions AS (
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
    effective_from,
    effective_until
  )
  SELECT
    COALESCE(
      (
        SELECT id
        FROM settings_versions
        WHERE category = 'label_design'
          AND scope_type = 'tenant'
          AND scope_id = t.scope_id
        ORDER BY approved_at DESC
        LIMIT 1
      ),
      uuid_from_hash(format('label_design:tenant:%s:masarx_waybill_v1', t.scope_id))
    ) AS id,
    'label_design',
    'tenant',
    t.scope_id,
    t.scope_id,
    1,
    config.payload,
    2,
    'Tenant label template refresh to MasarX waybill v1.1',
    now(),
    now(),
    NULL
  FROM tenant_refresh t
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
), renderer_defaults_payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'fallback_title', 'MasarX Waybill',
    'brand_name', 'MasarX',
    'primary_color', '#2D3F90',
    'template_key', 'masarx_waybill_v1'
  ) AS payload
), renderer_defaults_version AS (
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
    effective_from,
    effective_until
  )
  SELECT
    COALESCE(
      (
        SELECT id
        FROM settings_versions
        WHERE category = 'renderer_defaults'
          AND scope_type = 'global'
          AND scope_id IS NULL
        ORDER BY approved_at DESC
        LIMIT 1
      ),
      '77770000-0000-0000-0000-000000000211'::uuid
    ) AS id,
    'renderer_defaults',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    renderer_defaults_payload.payload,
    1,
    'Align renderer defaults to MasarX waybill template',
    now(),
    now(),
    NULL
  FROM renderer_defaults_payload
  ON CONFLICT (id, scope_hash) DO UPDATE
  SET value = EXCLUDED.value,
      change_reason = EXCLUDED.change_reason,
      approved_at = EXCLUDED.approved_at,
      effective_from = EXCLUDED.effective_from,
      effective_until = EXCLUDED.effective_until
  RETURNING id, value
)
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
  '66660000-0000-0000-0000-000000000211'::uuid,
  'renderer_defaults',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  renderer_defaults_version.id,
  renderer_defaults_version.value,
  now()
FROM renderer_defaults_version
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

COMMIT;
