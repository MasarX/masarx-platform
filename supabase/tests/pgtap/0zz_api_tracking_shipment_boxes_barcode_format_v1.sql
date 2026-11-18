-- pgTAP: API/provider tracking numbers with hyphens/case remain canonical box barcodes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SET search_path TO extensions, public, pg_temp;

SELECT plan(5);

DO $$
DECLARE
  v_org_id UUID := 'aaaaaaaa-4444-4000-8000-00000000b501';
  v_client_id UUID := 'bbbb0000-4444-4000-8000-00000000b502';
  v_sender_id UUID := 'cccc0000-4444-4000-8000-00000000b503';
  v_address_id UUID := 'dddd0000-4444-4000-8000-00000000b504';
  v_shipment_id UUID := 'eeee0000-4444-4000-8000-00000000b505';
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  VALUES (v_org_id, 'pgTAP API Tracking Box Org', 'pgtap-api-tracking-box-org', 'Asia/Riyadh', 'en-US', 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client_id, v_org_id, 'pgTAP API Tracking Box Client', 'pgtap-api-tracking-box-client', 'standard', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender_id,
    v_client_id,
    'pgTAP API Tracking Box Sender',
    'pgTAP API Tracking Box Sender',
    TRUE,
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org_id,
    'pgtap:api-tracking-shipment-boxes-barcode-format-fixture-bootstrap'
  );

  INSERT INTO addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    city,
    province,
    country,
    validation_status
  )
  VALUES (
    v_address_id,
    v_org_id,
    v_client_id,
    'pgTAP API tracking box address',
    'Riyadh',
    'Riyadh',
    'SA',
    'pending'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO shipments (
    id,
    organization_id,
    client_id,
    service_type,
    tracking_number,
    status,
    box_count,
    origin_address_id,
    destination_address_id,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_shipment_id,
    v_org_id,
    v_client_id,
    'delivery',
    'Mv2Close-PGTap-001',
    'pending',
    1,
    v_address_id,
    v_address_id,
    jsonb_build_object('source', 'pgtap_api_gateway_tracking'),
    now(),
    now()
  )
  ON CONFLICT (id, client_id) DO NOTHING;
END $$;

SELECT is(
  (
    SELECT count(*)::INTEGER
      FROM public.ensure_shipment_boxes('eeee0000-4444-4000-8000-00000000b505', 1)
     WHERE inserted IS TRUE
  ),
  1,
  'ensure_shipment_boxes inserts the missing API-tracked shipment box'
);

SELECT is(
  (
    SELECT barcode
      FROM public.shipment_boxes
     WHERE shipment_id = 'eeee0000-4444-4000-8000-00000000b505'
       AND box_number = 1
  ),
  'Mv2Close-PGTap-001:1',
  'box barcode preserves the mixed-case hyphenated API tracking number'
);

SELECT ok(
  (
    SELECT barcode
      FROM public.shipment_boxes
     WHERE shipment_id = 'eeee0000-4444-4000-8000-00000000b505'
       AND box_number = 1
  ) ~ '^[A-Za-z0-9][A-Za-z0-9-]*:[1-9][0-9]*$',
  'box barcode matches the canonical mixed-case hyphen-aware format'
);

SELECT throws_ok(
  $$
    INSERT INTO public.shipment_boxes (
      shipment_id,
      organization_id,
      client_id,
      box_number,
      barcode,
      status,
      created_at
    )
    VALUES (
      'eeee0000-4444-4000-8000-00000000b505',
      'aaaaaaaa-4444-4000-8000-00000000b501',
      'bbbb0000-4444-4000-8000-00000000b502',
      2,
      'Mv2Close-PGTap-001:02',
      'pending',
      now()
    )
  $$,
  '23514',
  'new row for relation "shipment_boxes" violates check constraint "shipment_boxes_barcode_format"',
  'box barcode rejects a leading-zero box number'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'shipment_boxes_barcode_format'
       AND conrelid = 'public.shipment_boxes'::regclass
       AND pg_get_constraintdef(oid) LIKE '%[A-Za-z0-9-]%'
  ),
  'shipment_boxes_barcode_format permits mixed-case hyphenated tracking segments'
);

SELECT * FROM finish();

ROLLBACK;
