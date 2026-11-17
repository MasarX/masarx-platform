BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT ok(
  to_regprocedure('public.find_shipment_by_tracking_v1(uuid,text)') IS NOT NULL,
  'find_shipment_by_tracking_v1 exists'
);

SELECT ok(
  to_regprocedure('public.resolve_shipment_create_duplicate_v1(uuid,text,text)') IS NOT NULL,
  'resolve_shipment_create_duplicate_v1 exists'
);

INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
VALUES ('7ab00000-0000-0000-0000-000000000001', 'pgTAP Shipment Create Org', 'pgtap-shipment-create-org', 'Asia/Riyadh', 'en-US', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
VALUES ('7ab00000-0000-0000-0000-000000000002', '7ab00000-0000-0000-0000-000000000001', 'pgTAP Shipment Create Client', 'pgtap-shipment-create-client', 'standard', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.shipments (
  id,
  organization_id,
  client_id,
  service_type,
  tracking_number,
  client_reference_number,
  status,
  box_count,
  created_at,
  updated_at
) VALUES
  (
    '7ab00000-0000-0000-0000-000000000011',
    '7ab00000-0000-0000-0000-000000000001',
    '7ab00000-0000-0000-0000-000000000002',
    'delivery',
    'PGTAP-DUP-TRACK-001',
    'PGTAP-DUP-REF-001',
    'pending',
    1,
    now(),
    now()
  ),
  (
    '7ab00000-0000-0000-0000-000000000012',
    '7ab00000-0000-0000-0000-000000000001',
    '7ab00000-0000-0000-0000-000000000002',
    'delivery',
    'PGTAP-DUP-TRACK-002',
    'PGTAP-DUP-REF-002',
    'pending',
    1,
    now(),
    now()
  )
ON CONFLICT (id, client_id) DO NOTHING;

SELECT is(
  (
    SELECT shipment_id::text
    FROM public.find_shipment_by_tracking_v1(
      '7ab00000-0000-0000-0000-000000000002',
      'pgtap-dup-track-001'
    )
    LIMIT 1
  ),
  '7ab00000-0000-0000-0000-000000000011',
  'find_shipment_by_tracking_v1 normalizes tracking values'
);

SELECT is(
  (
    SELECT operation
    FROM public.resolve_shipment_create_duplicate_v1(
      '7ab00000-0000-0000-0000-000000000002',
      'pgtap-dup-track-001',
      NULL
    )
    LIMIT 1
  ),
  'reused',
  'resolve_shipment_create_duplicate_v1 returns reused for tracking duplicates'
);

SELECT is(
  (
    SELECT matched_on
    FROM public.resolve_shipment_create_duplicate_v1(
      '7ab00000-0000-0000-0000-000000000002',
      'PGTAP-DUP-TRACK-001',
      'PGTAP-DUP-REF-001'
    )
    LIMIT 1
  ),
  'tracking+client_reference',
  'duplicate resolver records when both approved keys point to the same shipment'
);

SELECT is(
  (
    SELECT operation
    FROM public.resolve_shipment_create_duplicate_v1(
      '7ab00000-0000-0000-0000-000000000002',
      'PGTAP-NEW-TRACK-001',
      'pgtap-dup-ref-002'
    )
    LIMIT 1
  ),
  'reused_client_reference',
  'resolve_shipment_create_duplicate_v1 returns reused_client_reference for client reference duplicates'
);

SELECT is(
  (
    SELECT shipment_id::text
    FROM public.resolve_shipment_create_duplicate_v1(
      '7ab00000-0000-0000-0000-000000000002',
      'PGTAP-NEW-TRACK-001',
      'pgtap-dup-ref-002'
    )
    LIMIT 1
  ),
  '7ab00000-0000-0000-0000-000000000012',
  'duplicate resolver reuses the shipment matched by client reference'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.resolve_shipment_create_duplicate_v1(
      '7ab00000-0000-0000-0000-000000000002',
      'PGTAP-BRAND-NEW-TRACK',
      'PGTAP-BRAND-NEW-REF'
    )
  ),
  'duplicate resolver returns no row when both approved keys are new'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.resolve_shipment_create_duplicate_v1(
      '7ab00000-0000-0000-0000-000000000002',
      'PGTAP-DUP-TRACK-001',
      'PGTAP-DUP-REF-002'
    )
  $$,
  'P0001',
  'shipment_create_duplicate_key_mismatch',
  'duplicate resolver fails closed when tracking and client reference point to different shipments'
);

SELECT * FROM finish();

ROLLBACK;
