-- pgTAP: public.v_shipment_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W24 (paired projection views — OPERATIONS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_shipment_directory',
  'public.v_shipment_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_shipment_directory',
  ARRAY[
    'id', 'client_id', 'organization_id', 'sender_id', 'recipient_id',
    'tracking_number', 'client_reference_number', 'carrier_reference_number',
    'service_type', 'service_level', 'status', 'status_updated_at',
    'cod_amount', 'cod_currency', 'declared_value',
    'box_count', 'promised_delivery_date', 'priority_score',
    'origin_address_id', 'destination_address_id',
    'metadata', 'created_at', 'updated_at',
    -- Address projections
    'destination_city', 'destination_district',
    'origin_city', 'origin_district',
    -- Counterparty label projections
    'client_label', 'sender_label', 'recipient_label',
    -- Counter projections
    'box_actual_count', 'label_count', 'scan_event_count', 'last_scan_at',
    'comms_attempt_count', 'active_task_count',
    -- Derived risk flag
    'is_at_risk'
  ],
  'v_shipment_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_shipment_directory', 'SELECT'),
  'service_role has SELECT on v_shipment_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_shipment_directory', 'SELECT'),
  'anon has no SELECT on v_shipment_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_shipment_directory', 'SELECT'),
  'authenticated has SELECT on v_shipment_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'shipments'
       AND c.relkind = 'p'  -- partitioned table (HASH by client_id)
  ),
  'public.shipments remains a base partitioned table (SSOT preserved)'
);

-- 7) Projection: insert shipment with destination address, verify joins resolve.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000024a000';
  v_client UUID := '00000000-0000-0000-0000-00000024a001';
  v_sender UUID := '00000000-0000-0000-0000-00000024a002';
  v_recipient UUID := '00000000-0000-0000-0000-00000024a003';
  v_dest_addr UUID := '00000000-0000-0000-0000-00000024a004';
  v_origin_addr UUID := '00000000-0000-0000-0000-00000024a005';
  v_shipment UUID := '00000000-0000-0000-0000-00000024a006';
  v_dest_city TEXT;
  v_origin_city TEXT;
  v_client_label TEXT;
  v_sender_label TEXT;
  v_recipient_label TEXT;
  v_box_actual INT;
  v_label_count INT;
  v_at_risk BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W24 Shipment Directory Org', 'w24-shipment-dir-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'W24 Test Client', 'w24-test-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'W24 Test Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (
    id, organization_id, client_id, name, phone_number,
    preferred_language
  )
  VALUES (
    v_recipient, v_org, v_client, 'W24 Test Recipient', '+966500000024',
    'en'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, city, province,
    validation_status
  )
  VALUES (
    v_dest_addr, v_org, v_client, 'Dest Test', 'Riyadh', 'Riyadh',
    'valid'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, city, province,
    validation_status
  )
  VALUES (
    v_origin_addr, v_org, v_client, 'Origin Test', 'Jeddah', 'Makkah',
    'valid'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id, sender_id, recipient_id,
    service_type, tracking_number, box_count,
    destination_address_id, origin_address_id,
    cod_amount, cod_currency,
    promised_delivery_date,
    status
  )
  VALUES (
    v_shipment, v_org, v_client, v_sender, v_recipient,
    'delivery', 'W24-DLX-100024', 2,
    v_dest_addr, v_origin_addr,
    150.00, 'SAR',
    CURRENT_DATE + 1,
    'created'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO public.shipment_boxes (
    id, shipment_id, organization_id, client_id, box_number, barcode
  )
  VALUES
    (gen_random_uuid(), v_shipment, v_org, v_client, 1, 'W24DLX100024:1'),
    (gen_random_uuid(), v_shipment, v_org, v_client, 2, 'W24DLX100024:2')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.labels (
    shipment_id, organization_id, client_id, label_type, barcode, barcode_format,
    file_url, file_size_bytes
  )
  VALUES (
    v_shipment, v_org, v_client, 'shipping', 'W24DLX100024:1', 'CODE128',
    'https://example.invalid/labels/w24.pdf', 1024
  )
  ON CONFLICT DO NOTHING;

  SELECT
    destination_city, origin_city,
    client_label, sender_label, recipient_label,
    box_actual_count, label_count, is_at_risk
  INTO
    v_dest_city, v_origin_city,
    v_client_label, v_sender_label, v_recipient_label,
    v_box_actual, v_label_count, v_at_risk
  FROM public.v_shipment_directory
  WHERE id = v_shipment;

  PERFORM ok(
    v_dest_city = 'Riyadh'
      AND v_origin_city = 'Jeddah'
      AND v_client_label = 'W24 Test Client'
      AND v_sender_label = 'W24 Test Sender'
      AND v_recipient_label = 'W24 Test Recipient'
      AND v_box_actual = 2
      AND v_label_count = 1
      AND v_at_risk = FALSE,
    'v_shipment_directory projects destination_city + origin_city + counterparty labels + box_actual_count + label_count + is_at_risk'
  );
END;
$$;

-- 8) Negative path: delivery_failed status flips is_at_risk to TRUE; OFD past
-- promised date also flips it; created status with no overdue stays FALSE.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000024b000';
  v_client UUID := '00000000-0000-0000-0000-00000024b001';
  v_failed_ship UUID := '00000000-0000-0000-0000-00000024b002';
  v_overdue_ship UUID := '00000000-0000-0000-0000-00000024b003';
  v_failed_at_risk BOOLEAN;
  v_overdue_at_risk BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W24 Risk Test Org', 'w24-risk-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'W24 Risk Client', 'w24-risk-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id,
    service_type, tracking_number, box_count,
    status
  )
  VALUES (
    v_failed_ship, v_org, v_client,
    'delivery', 'W24-FAIL-024', 1,
    'delivery_failed'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  INSERT INTO public.shipments (
    id, organization_id, client_id,
    service_type, tracking_number, box_count,
    promised_delivery_date,
    status
  )
  VALUES (
    v_overdue_ship, v_org, v_client,
    'delivery', 'W24-OFD-024', 1,
    CURRENT_DATE - 2,
    'out_for_delivery'
  )
  ON CONFLICT (id, client_id) DO NOTHING;

  SELECT is_at_risk INTO v_failed_at_risk
    FROM public.v_shipment_directory WHERE id = v_failed_ship;
  SELECT is_at_risk INTO v_overdue_at_risk
    FROM public.v_shipment_directory WHERE id = v_overdue_ship;

  PERFORM ok(
    v_failed_at_risk = TRUE
      AND v_overdue_at_risk = TRUE,
    'v_shipment_directory derives is_at_risk for delivery_failed status and overdue out_for_delivery'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
