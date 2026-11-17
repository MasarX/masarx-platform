-- Migration: Label fallback branding support
-- Purpose: Extend label payload view with branding context (organization/client/sender names) for fallback rendering.
-- Date: 2025-11-12

BEGIN;

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
    origin.country AS origin_country
FROM shipments s
LEFT JOIN organizations org ON org.id = s.organization_id
LEFT JOIN clients c ON c.id = s.client_id
LEFT JOIN senders snd ON snd.id = s.sender_id
LEFT JOIN shipment_boxes sb ON sb.shipment_id = s.id
LEFT JOIN recipients r ON r.id = s.recipient_id
LEFT JOIN addresses dest ON dest.id = s.destination_address_id
LEFT JOIN addresses origin ON origin.id = s.origin_address_id;

COMMENT ON VIEW shipment_label_payload_v IS 'Flattened payload combining shipments, boxes, recipients, addresses, and branding context for label rendering.';

COMMIT;
