BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
VALUES (
  '22220000-0000-4000-8000-000000000001'::uuid,
  'PGTAP Fresh Org',
  'pgtap-fresh-org-2222',
  'Asia/Riyadh',
  'en-US',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
VALUES (
  '22220000-0000-4000-8000-000000000002'::uuid,
  '22220000-0000-4000-8000-000000000001'::uuid,
  'PGTAP Fresh Client',
  'pgtap-fresh-client-2222',
  'standard',
  'active'
)
ON CONFLICT (id) DO NOTHING;

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
  '22220000-0000-4000-8000-000000000003'::uuid,
  '22220000-0000-4000-8000-000000000001'::uuid,
  '22220000-0000-4000-8000-000000000002'::uuid,
  'PGTAP Fresh Address',
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
  created_at,
  updated_at
)
VALUES (
  '22220000-0000-4000-8000-000000000004'::uuid,
  '22220000-0000-4000-8000-000000000001'::uuid,
  '22220000-0000-4000-8000-000000000002'::uuid,
  'delivery',
  'PGTAPFRESH2222',
  'pending',
  1,
  '22220000-0000-4000-8000-000000000003'::uuid,
  '22220000-0000-4000-8000-000000000003'::uuid,
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

INSERT INTO shipment_boxes (
  id,
  shipment_id,
  organization_id,
  client_id,
  box_number,
  barcode,
  created_at
)
VALUES (
  '22220000-0000-4000-8000-000000000005'::uuid,
  '22220000-0000-4000-8000-000000000004'::uuid,
  '22220000-0000-4000-8000-000000000001'::uuid,
  '22220000-0000-4000-8000-000000000002'::uuid,
  1,
  'PGTAPBOX2222:1',
  now()
)
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE _batch_reprint AS
SELECT
  1 AS seq,
  r.job_id,
  r.shipment_box_id,
  r.inserted
FROM public.request_label_generation_batch(
  '22220000-0000-4000-8000-000000000004'::uuid,
  'shipping',
  NULL,
  'workflow.labels_print:scope-a',
  ARRAY['22220000-0000-4000-8000-000000000005'::uuid],
  'reprint'
) AS r
UNION ALL
SELECT
  2 AS seq,
  r.job_id,
  r.shipment_box_id,
  r.inserted
FROM public.request_label_generation_batch(
  '22220000-0000-4000-8000-000000000004'::uuid,
  'shipping',
  NULL,
  'workflow.labels_print:scope-a',
  ARRAY['22220000-0000-4000-8000-000000000005'::uuid],
  'reprint'
) AS r
UNION ALL
SELECT
  3 AS seq,
  r.job_id,
  r.shipment_box_id,
  r.inserted
FROM public.request_label_generation_batch(
  '22220000-0000-4000-8000-000000000004'::uuid,
  'shipping',
  NULL,
  'workflow.labels_print:scope-b',
  ARRAY['22220000-0000-4000-8000-000000000005'::uuid],
  'reprint'
) AS r;

SELECT ok(
  (SELECT inserted FROM _batch_reprint WHERE seq = 1),
  'first reprint batch call inserts a new job'
);

SELECT is(
  (SELECT inserted FROM _batch_reprint WHERE seq = 2),
  false,
  'second reprint call with same scope reuses existing pending job'
);

SELECT is(
  (SELECT job_id FROM _batch_reprint WHERE seq = 1),
  (SELECT job_id FROM _batch_reprint WHERE seq = 2),
  'reprint idempotency is stable within same workflow/request scope'
);

SELECT ok(
  (SELECT inserted FROM _batch_reprint WHERE seq = 3),
  'reprint call with different scope inserts fresh job'
);

SELECT isnt(
  (SELECT job_id FROM _batch_reprint WHERE seq = 1),
  (SELECT job_id FROM _batch_reprint WHERE seq = 3),
  'reprint call with different scope does not reuse old job id'
);

CREATE TEMP TABLE _batch_primary AS
SELECT
  1 AS seq,
  r.job_id,
  r.inserted
FROM public.request_label_generation_batch(
  '22220000-0000-4000-8000-000000000004'::uuid,
  'shipping',
  NULL,
  'workflow.labels_print:primary-a',
  ARRAY['22220000-0000-4000-8000-000000000005'::uuid],
  'primary'
) AS r
UNION ALL
SELECT
  2 AS seq,
  r.job_id,
  r.inserted
FROM public.request_label_generation_batch(
  '22220000-0000-4000-8000-000000000004'::uuid,
  'shipping',
  NULL,
  'workflow.labels_print:primary-b',
  ARRAY['22220000-0000-4000-8000-000000000005'::uuid],
  'primary'
) AS r;

SELECT is(
  (SELECT inserted FROM _batch_primary WHERE seq = 2),
  false,
  'primary requests remain idempotent regardless requested_source changes'
);

SELECT is(
  (SELECT job_id FROM _batch_primary WHERE seq = 1),
  (SELECT job_id FROM _batch_primary WHERE seq = 2),
  'primary requests reuse same job id across requested_source changes'
);

SELECT * FROM finish();
ROLLBACK;
