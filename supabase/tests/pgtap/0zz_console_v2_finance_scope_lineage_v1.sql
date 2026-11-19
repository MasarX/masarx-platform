-- pgTAP: Console V2 finance scoped drill-ins are backed by registry filters,
-- not frontend substring matching.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT has_view('public', 'finance_events_ledger', 'finance_events_ledger projection exists');
SELECT has_column('public', 'finance_events_ledger', 'settlement_batch_id', 'ledger projection exposes settlement batch lineage');
SELECT has_column('public', 'finance_events_ledger', 'client_id', 'ledger projection exposes client lineage');
SELECT has_column('public', 'finance_events_ledger', 'partner_id', 'ledger projection exposes partner lineage');
SELECT has_column('public', 'v_settlement_batch_summary', 'client_id', 'settlement summary exposes client lineage');
SELECT has_column('public', 'v_dispute_directory', 'partner_id', 'dispute directory exposes partner lineage');

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
    WHERE r.value->>'key' = 'dispute_directory'
      AND r.value->>'relation' = 'public.v_dispute_directory'
      AND r.value->>'capability_read' = 'disputes.read'
  ),
  'ui_read_registry exposes dispute_directory through the disputes.read capability'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('settlement_batches', 'client_id'),
      ('settlement_batches', 'subject_id'),
      ('settlement_batch_summary', 'partner_id'),
      ('finance_events_ledger', 'settlement_batch_id'),
      ('finance_events_ledger', 'client_id'),
      ('finance_events_ledger', 'partner_id'),
      ('dispute_directory', 'client_id'),
      ('dispute_directory', 'partner_id')
    ) AS required(resource_key, filter_key)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL)->'resources') r(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.value->'filters', '[]'::jsonb)) f(value)
      WHERE r.value->>'key' = required.resource_key
        AND f.value->>'key' = required.filter_key
    )
  ),
  'ui_read_registry exposes exact finance scope filters'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'ui_read_registry'
      AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(
          (
            SELECT sg.cached_value
            FROM public.settings sg
            WHERE sg.category = 'ui_read_registry'
              AND sg.scope_type = 'global'
              AND sg.scope_id IS NULL
            LIMIT 1
          )->'resources',
          '[]'::jsonb
        )) gr(value)
        WHERE gr.value->>'key' IN (
          'settlement_batches',
          'settlement_batch_summary',
          'finance_events_ledger',
          'marketplace_disputes',
          'dispute_directory'
        )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) sr(value)
            WHERE sr.value->>'key' = gr.value->>'key'
          )
      )
  ),
  'scoped ui_read_registry rows include the required finance/dispute resources'
);

DELETE FROM public.marketplace_disputes
WHERE id = '66666666-6666-4666-8666-666666666666'::uuid;

DELETE FROM public.marketplace_requests
WHERE id = '55555555-5555-4555-8555-555555555555'::uuid;

DELETE FROM public.shipments
WHERE id IN (
  '33333333-3333-4333-8333-333333333333'::uuid,
  '44444444-4444-4444-8444-444444444444'::uuid
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'd8f3db0d-f270-4824-a62c-e86effc77160'::uuid,
  'Console V2 Finance Scope Org',
  'console-v2-finance-scope-d8f3db0d'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug)
VALUES (
  'c2e1b78a-982c-44b0-9f28-d2c297f55991'::uuid,
  'Console V2 Finance Supplier Org',
  'console-v2-finance-supplier-c2e1b78a'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
VALUES
  (
    '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830'::uuid,
    'd8f3db0d-f270-4824-a62c-e86effc77160'::uuid,
    'Console V2 Requester Client',
    'console-v2-requester-client',
    'standard',
    'active'
  ),
  (
    '22222222-2222-4222-8222-222222222222'::uuid,
    'c2e1b78a-982c-44b0-9f28-d2c297f55991'::uuid,
    'Console V2 Supplier Client',
    'console-v2-supplier-client',
    'standard',
    'active'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.shipments (
  id,
  organization_id,
  client_id,
  service_type,
  tracking_number,
  client_reference_number,
  status,
  metadata
)
VALUES
  (
    '33333333-3333-4333-8333-333333333333'::uuid,
    'd8f3db0d-f270-4824-a62c-e86effc77160'::uuid,
    '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830'::uuid,
    'delivery',
    'CV2-REQ-SCOPE',
    'CV2-COLLISION-REF',
    'created',
    '{}'::jsonb
  ),
  (
    '44444444-4444-4444-8444-444444444444'::uuid,
    'c2e1b78a-982c-44b0-9f28-d2c297f55991'::uuid,
    '22222222-2222-4222-8222-222222222222'::uuid,
    'delivery',
    'CV2-SUP-SCOPE',
    'CV2-COLLISION-REF',
    'created',
    '{}'::jsonb
  )
;

INSERT INTO public.marketplace_requests (
  id,
  requester_organization_id,
  request_kind_key,
  title,
  summary
)
VALUES (
  '55555555-5555-4555-8555-555555555555'::uuid,
  'd8f3db0d-f270-4824-a62c-e86effc77160'::uuid,
  COALESCE((SELECT kind_key FROM public.marketplace_request_kinds WHERE is_active = TRUE ORDER BY kind_key LIMIT 1), (SELECT kind_key FROM public.marketplace_request_kinds ORDER BY kind_key LIMIT 1)),
  'Console V2 Finance Collision',
  'Collision test'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.marketplace_disputes (
  id,
  request_id,
  opened_by_organization_id,
  counterparty_organization_id,
  status,
  category,
  title,
  metadata
)
VALUES (
  '66666666-6666-4666-8666-666666666666'::uuid,
  '55555555-5555-4555-8555-555555555555'::uuid,
  'c2e1b78a-982c-44b0-9f28-d2c297f55991'::uuid,
  'd8f3db0d-f270-4824-a62c-e86effc77160'::uuid,
  'open',
  'billing',
  'Shipment reference collision',
  jsonb_build_object('shipment_ref', 'CV2-COLLISION-REF', 'amount_sar', '10')
)
ON CONFLICT (id) DO NOTHING;

SELECT is(
  (SELECT count(*)::int FROM public.v_dispute_directory WHERE id = '66666666-6666-4666-8666-666666666666'::uuid),
  1,
  'dispute directory resolves one shipment when shipment refs collide across organizations'
);

SELECT is(
  (SELECT client_id FROM public.v_dispute_directory WHERE id = '66666666-6666-4666-8666-666666666666'::uuid),
  '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830'::uuid,
  'dispute directory resolves shipment client from requester organization only'
);

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  'd96b391e-e434-4146-ae1b-b00c8e7ba32f'::uuid,
  'd8f3db0d-f270-4824-a62c-e86effc77160'::uuid,
  'console-v2-finance-scope@example.test',
  'Console V2 Finance Scope Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', 'd96b391e-e434-4146-ae1b-b00c8e7ba32f', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'd96b391e-e434-4146-ae1b-b00c8e7ba32f',
    'role', 'authenticated',
    'email', 'console-v2-finance-scope@example.test'
  )::text,
  true
);

SET LOCAL ROLE authenticated;

DO $probe$
DECLARE
  v_result JSONB;
BEGIN
  SELECT api.ui_list_resource_v1('finance_events_ledger', '{"client_id":"00000000-0000-0000-0000-000000000001"}'::jsonb, 5, 0, NULL::jsonb)
    INTO v_result;
  IF v_result->>'resource' IS DISTINCT FROM 'finance_events_ledger' THEN
    RAISE EXCEPTION 'finance_events_ledger scoped list returned wrong resource';
  END IF;

  SELECT api.ui_list_resource_v1('dispute_directory', '{"partner_id":"00000000-0000-0000-0000-000000000002"}'::jsonb, 5, 0, NULL::jsonb)
    INTO v_result;
  IF v_result->>'resource' IS DISTINCT FROM 'dispute_directory' THEN
    RAISE EXCEPTION 'dispute_directory scoped list returned wrong resource';
  END IF;
END;
$probe$;

RESET ROLE;

SELECT pass('Console V2 finance scoped resource reads accept exact lineage filters');

SELECT * FROM finish();

ROLLBACK;
