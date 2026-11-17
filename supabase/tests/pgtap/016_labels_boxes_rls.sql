-- Test Suite: RLS on labels and shipment_boxes

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='labels'),
  'RLS enabled on labels'
);

SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='shipment_boxes'),
  'RLS enabled on shipment_boxes'
);

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.labels LIMIT 1 $$,
  '42501',
  'permission denied for table labels'
);
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.shipment_boxes LIMIT 1 $$,
  '42501',
  'permission denied for table shipment_boxes'
);
RESET ROLE;

SELECT finish();

ROLLBACK;
