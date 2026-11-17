-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S02
-- Migration: label_field_catalog (SSOT curated bindings for designer)
-- Purpose:
--   - Provide a ladder-resolved, row-driven curated field catalog for the browser label designer.
--   - Keep the designer dynamic: UI renders the catalog; templates bind by value_path (no hardcoding).
BEGIN;

SET search_path TO public, pg_temp;

-- Category governance (SSOT): designer-only, but still ladder-resolved.
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'label_field_catalog',
  'Curated label field catalog for designer bindings (value_path + EN/AR labels + examples).',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

WITH contract AS (
  SELECT
    $${
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "label_field_catalog.schema.v1.json",
      "title": "label_field_catalog",
      "type": "object",
      "required": ["version", "fields"],
      "additionalProperties": false,
      "properties": {
        "version": { "type": "integer", "minimum": 1 },
        "fields": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/$defs/field" }
        }
      },
      "$defs": {
        "field": {
          "type": "object",
          "required": ["key", "value_path", "label_en", "label_ar"],
          "additionalProperties": false,
          "properties": {
            "key": { "type": "string", "minLength": 1, "maxLength": 80 },
            "value_path": { "type": "string", "minLength": 1 },
            "label_en": { "type": "string", "minLength": 1 },
            "label_ar": { "type": "string", "minLength": 1 },
            "group": { "type": "string" },
            "data_type": { "type": "string", "enum": ["string", "number", "boolean", "date", "json"] },
            "description": { "type": "string" },
            "example": {},
            "ui": { "type": "object", "additionalProperties": true }
          }
        }
      }
    }$$::jsonb AS schema_doc,
    $${
      "version": 1,
      "fields": [
        { "key": "tracking_number", "value_path": "tracking_number", "label_en": "Tracking Number", "label_ar": "رقم التتبع", "group": "Shipment", "data_type": "string", "example": "DXX123456789" },
        { "key": "service_type", "value_path": "service_type", "label_en": "Service Type", "label_ar": "نوع الخدمة", "group": "Shipment", "data_type": "string", "example": "Standard" },
        { "key": "service_level_label", "value_path": "service_level_label", "label_en": "Service Level", "label_ar": "مستوى الخدمة", "group": "Shipment", "data_type": "string", "example": "Standard" },
        { "key": "payment_term_label", "value_path": "payment_term_label", "label_en": "Payment Term", "label_ar": "طريقة الدفع", "group": "Shipment", "data_type": "string", "example": "COD" },
        { "key": "cod_amount", "value_path": "cod_amount", "label_en": "COD Amount", "label_ar": "مبلغ الدفع عند الاستلام", "group": "Shipment", "data_type": "number", "example": 25.5 },
        { "key": "cod_currency", "value_path": "cod_currency", "label_en": "COD Currency", "label_ar": "عملة الدفع عند الاستلام", "group": "Shipment", "data_type": "string", "example": "SAR" },
        { "key": "cod_label", "value_path": "cod_label", "label_en": "COD Label", "label_ar": "الدفع عند الاستلام", "group": "Shipment", "data_type": "string", "example": "25.5 SAR" },
        { "key": "reference_number", "value_path": "reference_number", "label_en": "Reference Number", "label_ar": "رقم المرجع", "group": "Shipment", "data_type": "string", "example": "REF-001" },
        { "key": "created_at_local", "value_path": "created_at_local", "label_en": "Created At (Local)", "label_ar": "تاريخ الإنشاء (محلي)", "group": "Shipment", "data_type": "string", "example": "2025-12-30 14:33:10" },
        { "key": "special_instructions", "value_path": "special_instructions", "label_en": "Special Instructions", "label_ar": "ملاحظات", "group": "Shipment", "data_type": "string", "example": "Call on arrival" },

        { "key": "recipient_name", "value_path": "recipient_name", "label_en": "Recipient Name", "label_ar": "اسم المستلم", "group": "Recipient", "data_type": "string", "example": "Ahmed" },
        { "key": "recipient_phone", "value_path": "recipient_phone", "label_en": "Recipient Phone", "label_ar": "رقم هاتف المستلم", "group": "Recipient", "data_type": "string", "example": "+9665XXXXXXX" },

        { "key": "destination_sa_short_code", "value_path": "destination_sa_short_code", "label_en": "National Address Short Code", "label_ar": "العنوان الوطني المختصر", "group": "Destination", "data_type": "string", "example": "ABCD1234" },
        { "key": "destination_line1", "value_path": "destination_line1", "label_en": "Destination Line 1", "label_ar": "عنوان الوجهة ١", "group": "Destination", "data_type": "string", "example": "Building 10, King Fahd Rd" },
        { "key": "destination_line2", "value_path": "destination_line2", "label_en": "Destination Line 2", "label_ar": "عنوان الوجهة ٢", "group": "Destination", "data_type": "string", "example": "Apt 3" },
        { "key": "destination_building_number", "value_path": "destination_building_number", "label_en": "Destination Building No.", "label_ar": "رقم مبنى الوجهة", "group": "Destination", "data_type": "string", "example": "10" },
        { "key": "destination_district", "value_path": "destination_district", "label_en": "Destination District", "label_ar": "حي الوجهة", "group": "Destination", "data_type": "string", "example": "Al Olaya" },
        { "key": "destination_city", "value_path": "destination_city", "label_en": "Destination City", "label_ar": "مدينة الوجهة", "group": "Destination", "data_type": "string", "example": "Riyadh" },
        { "key": "destination_province", "value_path": "destination_province", "label_en": "Destination Province", "label_ar": "منطقة الوجهة", "group": "Destination", "data_type": "string", "example": "Riyadh" },
        { "key": "destination_postal_code", "value_path": "destination_postal_code", "label_en": "Destination Postal Code", "label_ar": "الرمز البريدي للوجهة", "group": "Destination", "data_type": "string", "example": "12345" },
        { "key": "destination_summary", "value_path": "destination_summary", "label_en": "Destination Summary", "label_ar": "ملخص الوجهة", "group": "Destination", "data_type": "string", "example": "Riyadh, Riyadh, SA" },

        { "key": "origin_line1", "value_path": "origin_line1", "label_en": "Origin Line 1", "label_ar": "عنوان الأصل ١", "group": "Origin", "data_type": "string", "example": "Warehouse 1" },
        { "key": "origin_city", "value_path": "origin_city", "label_en": "Origin City", "label_ar": "مدينة الأصل", "group": "Origin", "data_type": "string", "example": "Riyadh" },
        { "key": "origin_summary", "value_path": "origin_summary", "label_en": "Origin Summary", "label_ar": "ملخص الأصل", "group": "Origin", "data_type": "string", "example": "Riyadh, Riyadh, SA" },

        { "key": "zone_name", "value_path": "zone_name", "label_en": "Zone", "label_ar": "الزون", "group": "Routing", "data_type": "string", "example": "Zone A" },
        { "key": "zone_slug", "value_path": "zone_slug", "label_en": "Zone Code", "label_ar": "رمز الزون", "group": "Routing", "data_type": "string", "example": "zone-a" },

        { "key": "box_number", "value_path": "box_number", "label_en": "Box Number", "label_ar": "رقم الصندوق", "group": "Box", "data_type": "number", "example": 1 },
        { "key": "barcode_value", "value_path": "barcode_value", "label_en": "Barcode Value", "label_ar": "قيمة الباركود", "group": "Box", "data_type": "string", "example": "DXX123456789" },
        { "key": "weight_label", "value_path": "weight_label", "label_en": "Weight", "label_ar": "الوزن", "group": "Box", "data_type": "string", "example": "1.2 kg" },
        { "key": "bundle_label", "value_path": "bundle_label", "label_en": "Bundle Label", "label_ar": "ترقيم الطرد", "group": "Box", "data_type": "number", "example": 1 }
      ]
    }$$::jsonb AS default_value,
    'Curated label field catalog for the label designer (ladder-resolved; SSOT).'::text AS description
),
upsert_schema AS (
  INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active, created_at)
  SELECT
    'label_field_catalog',
    1,
    contract.schema_doc,
    contract.description,
    jsonb_build_array(contract.default_value),
    TRUE,
    workflow_now()
  FROM contract
  ON CONFLICT (category, version) DO UPDATE
  SET
    schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE,
    created_at = workflow_now()
  RETURNING 1
),
activate_schema AS (
  UPDATE public.schema_registry
  SET is_active = CASE WHEN version = 1 THEN TRUE ELSE FALSE END
  WHERE category = 'label_field_catalog'
  RETURNING 1
),
upsert_version AS (
  INSERT INTO public.settings_versions (
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
    uuid_from_hash('label_field_catalog:global:1'),
    'label_field_catalog',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    contract.default_value,
    1,
    'Seed global label_field_catalog baseline',
    workflow_now(),
    workflow_now(),
    NULL
  FROM contract
  ON CONFLICT (id, scope_hash) DO UPDATE
  SET
    value = EXCLUDED.value,
    schema_version = EXCLUDED.schema_version,
    change_reason = EXCLUDED.change_reason,
    approved_at = EXCLUDED.approved_at,
    effective_from = EXCLUDED.effective_from,
    effective_until = EXCLUDED.effective_until
  RETURNING id, value
),
apply_settings AS (
  INSERT INTO public.settings (
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
    uuid_from_hash('label_field_catalog:global:cache'),
    'label_field_catalog',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    upsert_version.id,
    upsert_version.value,
    workflow_now()
  FROM upsert_version
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated
  RETURNING 1
)
SELECT 1;

COMMIT;

