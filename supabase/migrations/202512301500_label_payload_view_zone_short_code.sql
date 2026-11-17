-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S02
-- Migration: Extend shipment_label_payload_v (zone + Saudi short code)
-- Purpose:
--   - Add zone fields + destination_sa_short_code to the label payload (DB values as-is).
--   - Keep label templates fully data-driven by ensuring required raw fields are bindable.
BEGIN;

SET search_path TO public, pg_temp;

-- IMPORTANT: Preserve the existing column order of shipment_label_payload_v
-- so CREATE OR REPLACE does not attempt to rename prior columns. New columns
-- MUST be appended at the end.
CREATE OR REPLACE VIEW public.shipment_label_payload_v AS
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
      CASE WHEN sb.weight_kg IS NOT NULL THEN trim(to_char(sb.weight_kg, 'FM9999990.##')) || ' kg' END,
      CASE WHEN sb.volumetric_weight_kg IS NOT NULL THEN trim(to_char(sb.volumetric_weight_kg, 'FM999990.##')) || ' kg (vol)' END
    ) AS weight_label,
    COALESCE(sb.barcode, s.tracking_number) AS barcode_value,
    public.select_shipment_reference_number_v1(
      s.organization_id,
      s.client_id,
      s.sender_id,
      s.id,
      s.tracking_number,
      s.client_reference_number,
      s.carrier_reference_number
    ) AS reference_number,
    COALESCE(sb.box_number, 1) AS bundle_label,
    CASE WHEN dest.city IS NOT NULL THEN upper(substr(dest.city, 1, 3)) ELSE NULL END AS destination_city_code,
    concat_ws(', ', NULLIF(origin.city, ''), NULLIF(origin.province, ''), NULLIF(origin.country, '')) AS origin_summary,
    concat_ws(', ', NULLIF(dest.city, ''), NULLIF(dest.province, ''), NULLIF(dest.country, '')) AS destination_summary,
    s.zone_id,
    z.name AS zone_name,
    z.slug AS zone_slug,
    dest.building_number AS destination_building_number,
    dest.additional_directions AS destination_additional_directions,
    dest.sa_short_code AS destination_sa_short_code,
    origin.building_number AS origin_building_number
FROM shipments s
LEFT JOIN organizations org ON org.id = s.organization_id
LEFT JOIN clients c ON c.id = s.client_id
LEFT JOIN senders snd ON snd.id = s.sender_id
LEFT JOIN zones z ON z.id = s.zone_id
LEFT JOIN shipment_boxes sb ON sb.shipment_id = s.id
LEFT JOIN recipients r ON r.id = s.recipient_id
LEFT JOIN addresses dest ON dest.id = s.destination_address_id
LEFT JOIN addresses origin ON origin.id = s.origin_address_id;

COMMENT ON VIEW public.shipment_label_payload_v IS
  'Flattened payload combining shipments, boxes, recipients, addresses, and branding context for label rendering (derived + raw bindable fields incl. zone + Saudi short code).';

REVOKE ALL ON public.shipment_label_payload_v FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shipment_label_payload_v TO label_renderer_role;
GRANT SELECT ON public.shipment_label_payload_v TO service_role;

COMMIT;
