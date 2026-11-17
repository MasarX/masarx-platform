-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S95
-- pgTAP: Enum mapping helpers v1 (normalize + lookup validate + field_mappings resolver)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(17);

-- ----------------------------------------------------------------------------
-- Function existence
-- ----------------------------------------------------------------------------

SELECT has_function(
  'public',
  'normalize_enum_key_v1',
  ARRAY['text'],
  'normalize_enum_key_v1(text) exists'
);

SELECT has_function(
  'public',
  'is_active_lookup_value_v1',
  ARRAY['text','text','boolean'],
  'is_active_lookup_value_v1(text,text,boolean) exists'
);

SELECT has_function(
  'public',
  'resolve_field_mapping_enum_v1',
  ARRAY['text','text','text','text'],
  'resolve_field_mapping_enum_v1(text,text,text,text) exists'
);

-- ----------------------------------------------------------------------------
-- normalize_enum_key_v1
-- ----------------------------------------------------------------------------

SELECT is(
  public.normalize_enum_key_v1(' Created '),
  'CREATED',
  'normalize_enum_key_v1 trims + uppercases'
);

SELECT is(
  public.normalize_enum_key_v1('in-transit'),
  'IN_TRANSIT',
  'normalize_enum_key_v1 coerces separators to underscore'
);

SELECT is(
  public.normalize_enum_key_v1(''),
  NULL::TEXT,
  'normalize_enum_key_v1 returns NULL for blank'
);

-- ----------------------------------------------------------------------------
-- is_active_lookup_value_v1 (lookup_definitions/lookup_values)
-- ----------------------------------------------------------------------------

SELECT ok(
  public.is_active_lookup_value_v1('shipment_status', 'created', TRUE),
  'shipment_status.created is active'
);

SELECT ok(
  public.is_active_lookup_value_v1('shipment_status', 'pending_dispatch', TRUE),
  'shipment_status.pending_dispatch is active'
);

SELECT ok(
  NOT public.is_active_lookup_value_v1('shipment_status', '__nope__', TRUE),
  'shipment_status.__nope__ is not active'
);

SELECT ok(
  NOT public.is_active_lookup_value_v1('pgtap_missing_category', 'anything', TRUE),
  'missing category returns FALSE when require_definition=true'
);

SELECT ok(
  public.is_active_lookup_value_v1('pgtap_missing_category', 'anything', FALSE),
  'missing category returns TRUE when require_definition=false'
);

-- ----------------------------------------------------------------------------
-- resolve_field_mapping_enum_v1 (field_mappings)
-- ----------------------------------------------------------------------------

INSERT INTO public.field_mappings (id, mapping_domain, provider_name, direction, provider_value, canonical_value)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'shipment_status', 'pgtap_enum_helpers', 'both', 'DISPATCH', 'pending_dispatch'),
  ('22222222-2222-2222-2222-222222222222', 'shipment_status', 'pgtap_enum_helpers', 'inbound', 'DISPATCH', 'created');

SELECT is(
  (
    SELECT provider_value_normalized
    FROM public.resolve_field_mapping_enum_v1('shipment_status', 'pgtap_enum_helpers', 'inbound', ' dispatch ')
  ),
  'DISPATCH',
  'resolve_field_mapping_enum_v1 returns normalized provider value'
);

SELECT is(
  (
    SELECT canonical_value
    FROM public.resolve_field_mapping_enum_v1('shipment_status', 'pgtap_enum_helpers', 'inbound', ' dispatch ')
  ),
  'created',
  'resolve_field_mapping_enum_v1 prefers direction-specific mapping'
);

SELECT is(
  (
    SELECT mapping_id
    FROM public.resolve_field_mapping_enum_v1('shipment_status', 'pgtap_enum_helpers', 'inbound', ' dispatch ')
  ),
  '22222222-2222-2222-2222-222222222222'::uuid,
  'resolve_field_mapping_enum_v1 returns direction-specific mapping id'
);

SELECT is(
  (
    SELECT canonical_value
    FROM public.resolve_field_mapping_enum_v1('shipment_status', 'pgtap_enum_helpers', 'outbound', ' dispatch ')
  ),
  'pending_dispatch',
  'resolve_field_mapping_enum_v1 falls back to direction=both'
);

SELECT is(
  (
    SELECT mapping_id
    FROM public.resolve_field_mapping_enum_v1('shipment_status', 'pgtap_enum_helpers', 'outbound', ' dispatch ')
  ),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'resolve_field_mapping_enum_v1 returns fallback direction=both mapping id'
);

-- ----------------------------------------------------------------------------
-- Invariants: enum-like mapping domains must map to active lookup values
-- ----------------------------------------------------------------------------

SELECT ok(
  (
    WITH bad AS (
      SELECT fm.mapping_domain, fm.provider_name, fm.direction, fm.provider_value, fm.canonical_value
      FROM public.field_mappings fm
      LEFT JOIN public.lookup_definitions ld
        ON ld.category = fm.mapping_domain
      LEFT JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
       AND lv.value = fm.canonical_value
       AND lv.status = 'active'
      WHERE fm.mapping_domain IN ('shipment_status', 'service_type', 'service_level')
        AND lv.id IS NULL
    )
    SELECT COUNT(*) = 0 FROM bad
  ),
  'field_mappings canonical_value exists as active lookup_value for enum-like domains'
);

SELECT * FROM finish();

ROLLBACK;

