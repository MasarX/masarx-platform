-- pgTAP: public.v_settlement_batch_summary projection contract (shape/RLS/projection)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_settlement_batch_summary',
  'public.v_settlement_batch_summary view exists'
);

-- 2) View has the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_settlement_batch_summary',
  ARRAY[
    'id', 'organization_id', 'kind', 'scope_type', 'status',
    'window_start_at', 'window_end_at', 'created_at', 'updated_at',
    'expected_amount', 'collected_amount', 'remitted_amount',
    'posted_at', 'variance_flag', 'branch_id', 'client_id', 'sender_id',
    'subject_type', 'subject_id', 'partner_id', 'participant_id',
    'supplier_participant_profile_id'
  ],
  'v_settlement_batch_summary exposes the FE projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_settlement_batch_summary', 'SELECT'),
  'service_role has SELECT on v_settlement_batch_summary'
);

-- 4) anon must not have direct SELECT on the view (strict baseline)
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_settlement_batch_summary', 'SELECT'),
  'anon has no SELECT on v_settlement_batch_summary'
);

-- 5) Underlying tables remain SSOT (existence proxies for "not replaced by view")
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'settlement_batches'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.settlement_batches remains a base table (SSOT preserved)'
);

-- 6) Projection: insert a settlement_batch with metadata expected/collected and verify the view echoes them.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000c4b0';
  v_batch UUID := '00000000-0000-0000-0000-00000000c4b1';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W84 View Org', 'w84-view-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, status, version, metadata
  )
  VALUES (
    v_batch, v_org, 'cod', 'driver_shift', 'open', 1,
    jsonb_build_object(
      'expected_amount', 500,
      'collected_amount', 480,
      'payment_collection_summary', jsonb_build_object('remitted_amount', 375)
    )
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w84v_batch', v_batch::text, true);
  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT (expected_amount)::text FROM public.v_settlement_batch_summary
    WHERE id = current_setting('test.w84v_batch')::uuid),
  '500',
  'v_settlement_batch_summary projects expected_amount from metadata'
);

SELECT is(
  (SELECT (remitted_amount)::text FROM public.v_settlement_batch_summary
    WHERE id = current_setting('test.w84v_batch')::uuid),
  '375',
  'v_settlement_batch_summary projects COD remitted_amount from payment collection summary metadata'
);

-- 8) Projection: linked finance-event truth supersedes stale metadata summary once batch membership exists.
DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000c4b0';
  v_batch UUID := '00000000-0000-0000-0000-00000000c4b2';
  v_to_event UUID;
  v_from_event UUID;
  v_to_at TIMESTAMPTZ;
  v_from_at TIMESTAMPTZ;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, status, version, metadata
  )
  VALUES (
    v_batch, v_org, 'cod', 'driver_shift', 'approved', 1,
    jsonb_build_object(
      'expected_amount', 30,
      'collected_amount', 30,
      'payment_collection_summary', jsonb_build_object('remitted_amount', 0)
    )
  )
  ON CONFLICT (id) DO UPDATE
    SET metadata = EXCLUDED.metadata;

  SELECT finance_event_id
    INTO v_to_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', v_org,
    'event_type', 'cod_handover',
    'direction', 'in',
    'amount', 30,
    'currency', 'SAR',
    'account_type', 'branch',
    'account_id', v_org,
    'subject_type', 'settlement_batch',
    'subject_id', v_batch,
    'idempotency_key', 'w84-view-settlement-summary-to',
    'metadata', jsonb_build_object('side', 'to', 'transfer_id', 'w84-view-transfer')
  ))
  LIMIT 1;

  SELECT finance_event_id
    INTO v_from_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', v_org,
    'event_type', 'cod_handover',
    'direction', 'out',
    'amount', 30,
    'currency', 'SAR',
    'account_type', 'driver',
    'account_id', v_org,
    'subject_type', 'settlement_batch',
    'subject_id', v_batch,
    'idempotency_key', 'w84-view-settlement-summary-from',
    'metadata', jsonb_build_object('side', 'from', 'transfer_id', 'w84-view-transfer')
  ))
  LIMIT 1;

  SELECT occurred_at INTO v_to_at
  FROM public.finance_events
  WHERE organization_id = v_org AND id = v_to_event
  LIMIT 1;

  SELECT occurred_at INTO v_from_at
  FROM public.finance_events
  WHERE organization_id = v_org AND id = v_from_event
  LIMIT 1;

  INSERT INTO public.settlement_batch_finance_events (
    settlement_batch_id, organization_id, finance_event_id, finance_occurred_at
  )
  VALUES
    (v_batch, v_org, v_to_event, v_to_at),
    (v_batch, v_org, v_from_event, v_from_at)
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.w84v_batch_with_ledger', v_batch::text, true);
  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (SELECT (remitted_amount)::text FROM public.v_settlement_batch_summary
    WHERE id = current_setting('test.w84v_batch_with_ledger')::uuid),
  '30',
  'v_settlement_batch_summary prefers linked COD handover ledger truth over stale metadata remitted summary'
);

SELECT * FROM finish();
ROLLBACK;
