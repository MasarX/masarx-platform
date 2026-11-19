-- pgTAP: Console V2 manual shipment intake must fail closed for inactive senders.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT has_function(
  'public',
  'ui_create_shipment_v1',
  ARRAY['uuid', 'uuid', 'text', 'text', 'text', 'text', 'text', 'jsonb'],
  'public.ui_create_shipment_v1 exists'
);

SELECT ok(
  lower(pg_get_functiondef('public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)'::regprocedure))
    LIKE '%v_sender_status%',
  'ui_create_shipment_v1 reads sender status'
);

SELECT ok(
  lower(pg_get_functiondef('public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)'::regprocedure))
    LIKE '%sender is inactive%',
  'ui_create_shipment_v1 rejects inactive senders'
);

SELECT ok(
  lower(pg_get_functiondef('public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)'::regprocedure))
    LIKE '%using errcode = ''42501''%',
  'inactive sender rejection uses permission-denied semantics'
);

SELECT * FROM finish();
ROLLBACK;
