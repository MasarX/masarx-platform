BEGIN;

SELECT plan(6);

SELECT ok(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure))
    LIKE '%ensure_shipment_boxes%',
  'manual shipment intake resolves shipment_boxes before label queueing'
);

SELECT ok(
  strpos(
    lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)),
    'ensure_shipment_boxes'
  ) < strpos(
    lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)),
    'v_label_job_id := public.request_label_generation'
  ),
  'manual shipment intake resolves the shipment box before request_label_generation'
);

SELECT ok(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure))
    LIKE '%could not resolve shipment_box_id for label generation%',
  'manual shipment intake fails closed if box resolution is missing'
);

SELECT ok(
  pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure)
    LIKE '%manual_intake_label_box_readiness_v2%',
  'manual shipment intake carries the label-box readiness patch marker'
);

SELECT ok(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure))
    LIKE '%from public.shipment_boxes%',
  'manual shipment intake resolves the label box from canonical shipment_boxes'
);

SELECT ok(
  lower(pg_get_functiondef('public.ui_create_manual_shipment_intake_v1(jsonb)'::regprocedure))
    !~ 'ensure_shipment_boxes\(v_shipment_id,[[:space:]]*1\)',
  'manual shipment intake does not hardcode the box readiness count'
);

SELECT * FROM finish();

ROLLBACK;
