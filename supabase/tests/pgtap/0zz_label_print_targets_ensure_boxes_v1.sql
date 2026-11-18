-- pgTAP: label print target resolution must turn canonical shipment.box_count
-- into concrete shipment_boxes before printing.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

DO $do$
DECLARE
  v_org UUID := 'fb1951b2-e6c0-4f1e-9fdf-858e68a9ad01'::uuid;
  v_client UUID := 'ea0179c0-d065-4860-b7d8-bde7b867b8d3'::uuid;
  v_shipment UUID := 'f1d82f01-f2c2-4a21-8d1c-b6d7f7b88031'::uuid;
  v_result JSONB;
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Label Target Ensure Boxes Org', 'label-target-ensure-boxes-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status, sla_tier)
  VALUES (v_client, v_org, 'Label Target Ensure Boxes Client', 'label-target-ensure-boxes-client', 'active', 'standard')
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status;

  DELETE FROM public.shipment_boxes WHERE shipment_id = v_shipment;
  DELETE FROM public.shipments WHERE id = v_shipment;

  INSERT INTO public.shipments (
    id,
    organization_id,
    client_id,
    service_type,
    tracking_number,
    client_reference_number,
    status,
    box_count
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    'delivery',
    'LBLENSURE001',
    'LBL-ENSURE-001',
    'pending',
    1
  );

  v_result := public.resolve_label_print_targets_v1(
    v_org,
    jsonb_build_array(jsonb_build_object('shipment_id', v_shipment))
  );

  PERFORM is(
    v_result#>>'{counts,expected}',
    '1',
    'label target resolver reports one printable box target'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipment_boxes sb
       WHERE sb.shipment_id = v_shipment
         AND sb.organization_id = v_org
         AND sb.client_id = v_client
         AND sb.box_number = 1
         AND sb.barcode = 'LBLENSURE001:1'
    ),
    'label target resolver creates the missing shipment box from shipment.box_count'
  );

  PERFORM ok(
    jsonb_path_exists(v_result, '$.targets[*] ? (@.shipment_id == "f1d82f01-f2c2-4a21-8d1c-b6d7f7b88031" && @.box_number == 1)'),
    'label target resolver returns the created box as a printable target'
  );
END $do$;

SELECT * FROM finish();

ROLLBACK;
