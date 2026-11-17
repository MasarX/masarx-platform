BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
VALUES (
  '22330000-0000-4000-8000-000000000001'::uuid,
  'PGTAP Bulk Fresh Org',
  'pgtap-bulk-fresh-org-2233',
  'Asia/Riyadh',
  'en-US',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (id, organization_id, name, slug, sla_tier, status)
VALUES (
  '22330000-0000-4000-8000-000000000002'::uuid,
  '22330000-0000-4000-8000-000000000001'::uuid,
  'PGTAP Bulk Fresh Client',
  'pgtap-bulk-fresh-client-2233',
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
  '22330000-0000-4000-8000-000000000003'::uuid,
  '22330000-0000-4000-8000-000000000001'::uuid,
  '22330000-0000-4000-8000-000000000002'::uuid,
  'PGTAP Bulk Fresh Address',
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
  '22330000-0000-4000-8000-000000000004'::uuid,
  '22330000-0000-4000-8000-000000000001'::uuid,
  '22330000-0000-4000-8000-000000000002'::uuid,
  'delivery',
  'PGTAPBULK2233',
  'pending',
  1,
  '22330000-0000-4000-8000-000000000003'::uuid,
  '22330000-0000-4000-8000-000000000003'::uuid,
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
  '22330000-0000-4000-8000-000000000005'::uuid,
  '22330000-0000-4000-8000-000000000004'::uuid,
  '22330000-0000-4000-8000-000000000001'::uuid,
  '22330000-0000-4000-8000-000000000002'::uuid,
  1,
  'PGTAPBULKBOX2233:1',
  now()
)
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE _bulk_reprint AS
SELECT
  1 AS seq,
  r.job_id,
  r.shipment_id,
  r.shipment_box_id,
  r.inserted
FROM public.request_label_generation_bulk_v1(
  jsonb_build_array(
    jsonb_build_object(
      'shipment_id', '22330000-0000-4000-8000-000000000004'::uuid,
      'box_ids', jsonb_build_array('22330000-0000-4000-8000-000000000005'::uuid)
    )
  ),
  'shipping',
  NULL,
  'workflow.labels_print:scope-a',
  'reprint'
) AS r
UNION ALL
SELECT
  2 AS seq,
  r.job_id,
  r.shipment_id,
  r.shipment_box_id,
  r.inserted
FROM public.request_label_generation_bulk_v1(
  jsonb_build_array(
    jsonb_build_object(
      'shipment_id', '22330000-0000-4000-8000-000000000004'::uuid,
      'box_ids', jsonb_build_array('22330000-0000-4000-8000-000000000005'::uuid)
    )
  ),
  'shipping',
  NULL,
  'workflow.labels_print:scope-a',
  'reprint'
) AS r
UNION ALL
SELECT
  3 AS seq,
  r.job_id,
  r.shipment_id,
  r.shipment_box_id,
  r.inserted
FROM public.request_label_generation_bulk_v1(
  jsonb_build_array(
    jsonb_build_object(
      'shipment_id', '22330000-0000-4000-8000-000000000004'::uuid,
      'box_ids', jsonb_build_array('22330000-0000-4000-8000-000000000005'::uuid)
    )
  ),
  'shipping',
  NULL,
  'workflow.labels_print:scope-b',
  'reprint'
) AS r;

SELECT ok(
  (SELECT inserted FROM _bulk_reprint WHERE seq = 1),
  'first bulk reprint call inserts a new job'
);

SELECT is(
  (SELECT inserted FROM _bulk_reprint WHERE seq = 2),
  false,
  'second bulk reprint call with same scope reuses existing pending job'
);

SELECT is(
  (SELECT job_id FROM _bulk_reprint WHERE seq = 1),
  (SELECT job_id FROM _bulk_reprint WHERE seq = 2),
  'bulk reprint idempotency is stable within the same request scope'
);

SELECT ok(
  (SELECT inserted FROM _bulk_reprint WHERE seq = 3),
  'bulk reprint call with different scope inserts a fresh job'
);

SELECT isnt(
  (SELECT job_id FROM _bulk_reprint WHERE seq = 1),
  (SELECT job_id FROM _bulk_reprint WHERE seq = 3),
  'bulk reprint call with different scope does not reuse old job id'
);

CREATE TEMP TABLE _bulk_primary AS
SELECT
  1 AS seq,
  r.job_id,
  r.inserted
FROM public.request_label_generation_bulk_v1(
  jsonb_build_array(
    jsonb_build_object(
      'shipment_id', '22330000-0000-4000-8000-000000000004'::uuid,
      'box_ids', jsonb_build_array('22330000-0000-4000-8000-000000000005'::uuid)
    )
  ),
  'shipping',
  NULL,
  'workflow.labels_print:primary-a',
  'primary'
) AS r
UNION ALL
SELECT
  2 AS seq,
  r.job_id,
  r.inserted
FROM public.request_label_generation_bulk_v1(
  jsonb_build_array(
    jsonb_build_object(
      'shipment_id', '22330000-0000-4000-8000-000000000004'::uuid,
      'box_ids', jsonb_build_array('22330000-0000-4000-8000-000000000005'::uuid)
    )
  ),
  'shipping',
  NULL,
  'workflow.labels_print:primary-b',
  'primary'
) AS r;

SELECT is(
  (SELECT inserted FROM _bulk_primary WHERE seq = 2),
  false,
  'primary bulk requests remain idempotent regardless of requested_source changes'
);

SELECT is(
  (SELECT job_id FROM _bulk_primary WHERE seq = 1),
  (SELECT job_id FROM _bulk_primary WHERE seq = 2),
  'primary bulk requests reuse the same job id across requested_source changes'
);

SELECT is(
  public.request_label_generation_bulk_compact_v1(
    jsonb_build_array(
      jsonb_build_object(
        'shipment_id', '22330000-0000-4000-8000-000000000004'::uuid,
        'box_ids', jsonb_build_array('22330000-0000-4000-8000-000000000005'::uuid)
      )
    ),
    'shipping',
    NULL,
    'workflow.labels_print:compact-a',
    'reprint'
  )->>'job_count',
  '1',
  'compact bulk wrapper returns the ordered job count'
);

SELECT is(
  public.request_label_generation_bulk_compact_v1(
    jsonb_build_array(
      jsonb_build_object(
        'shipment_id', '22330000-0000-4000-8000-000000000004'::uuid,
        'box_ids', jsonb_build_array('22330000-0000-4000-8000-000000000005'::uuid)
      )
    ),
    'shipping',
    NULL,
    'workflow.labels_print:compact-a',
    'reprint'
  )->>'reused_count',
  '1',
  'compact bulk wrapper preserves request-scope reuse on repeated calls'
);

SELECT ok(
  COALESCE(
    jsonb_array_length(
      public.request_label_generation_bulk_compact_v1(
        jsonb_build_array(
          jsonb_build_object(
            'shipment_id', '22330000-0000-4000-8000-000000000004'::uuid,
            'box_ids', jsonb_build_array('22330000-0000-4000-8000-000000000005'::uuid)
          )
        ),
        'shipping',
        NULL,
        'workflow.labels_print:compact-b',
        'reprint'
      )->'job_ids'
    ),
    0
  ) = 1,
  'compact bulk wrapper returns ordered job ids'
);

SELECT * FROM finish();
ROLLBACK;
