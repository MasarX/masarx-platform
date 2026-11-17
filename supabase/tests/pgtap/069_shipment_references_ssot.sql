-- Test Suite: Shipment references SSOT + client reference uniqueness
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

SELECT has_column(
  'public',
  'shipments',
  'client_reference_upper',
  'shipments has client_reference_upper generated column'
);

SELECT has_index(
  'public',
  'shipments',
  'uniq_shipments_client_client_reference_upper',
  'shipments enforces per-client client_reference uniqueness (normalized)'
);

SELECT has_table(
  'public',
  'shipment_reference_numbers',
  'shipment_reference_numbers table exists'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='shipment_reference_numbers'),
  'RLS enabled on shipment_reference_numbers'
);

SELECT has_index(
  'public',
  'shipment_reference_numbers',
  'uniq_shipment_reference_numbers_shipment_type_value',
  'shipment_reference_numbers unique per shipment/type/value index exists'
);

SELECT has_index(
  'public',
  'shipment_reference_numbers',
  'idx_shipment_reference_numbers_lookup',
  'shipment_reference_numbers lookup index exists'
);

SELECT has_index(
  'public',
  'shipment_reference_numbers',
  'idx_shipment_reference_numbers_org_lookup',
  'shipment_reference_numbers org lookup index exists'
);

SELECT ok(
  EXISTS(
    SELECT 1
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename='shipment_reference_numbers'
      AND policyname='shipment_reference_numbers_service_policy'
  ),
  'shipment_reference_numbers service_role policy exists'
);

SELECT ok(
  EXISTS(
    SELECT 1
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename='shipment_reference_numbers'
      AND policyname='shipment_reference_numbers_tenant_select'
  ),
  'shipment_reference_numbers authenticated select policy exists'
);

SELECT * FROM finish();
ROLLBACK;

