BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(2);

SELECT ok(
  to_regprocedure(
    'workflow_handlers.record_shipment_action_v1(uuid,text,text,jsonb,text,text,text,uuid,timestamp with time zone)'
  ) IS NOT NULL,
  'record_shipment_action_v1 canonical 9-argument signature exists'
);

SELECT ok(
  to_regprocedure(
    'workflow_handlers.record_shipment_action_v1(uuid,text,text,jsonb,text,text,text,uuid)'
  ) IS NULL,
  'record_shipment_action_v1 legacy 8-argument overload is removed'
);

SELECT * FROM finish();
ROLLBACK;
