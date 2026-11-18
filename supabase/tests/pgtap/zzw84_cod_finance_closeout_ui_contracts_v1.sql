-- pgTAP: Console V2 COD/finance closeout wrappers
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(42);

SELECT has_function(
  'public',
  'ui_record_cod_remittance_v1',
  ARRAY['jsonb'],
  'public.ui_record_cod_remittance_v1(jsonb) is registered'
);
SELECT has_function(
  'api',
  'ui_record_cod_remittance_v1',
  ARRAY['jsonb'],
  'api.ui_record_cod_remittance_v1(jsonb) browser wrapper is registered'
);
SELECT has_function(
  'public',
  'ui_adjust_cod_collection_v1',
  ARRAY['jsonb'],
  'public.ui_adjust_cod_collection_v1(jsonb) is registered'
);
SELECT has_function(
  'api',
  'ui_adjust_cod_collection_v1',
  ARRAY['jsonb'],
  'api.ui_adjust_cod_collection_v1(jsonb) browser wrapper is registered'
);
SELECT has_function(
  'public',
  'ui_reverse_finance_event_v1',
  ARRAY['jsonb'],
  'public.ui_reverse_finance_event_v1(jsonb) is registered'
);
SELECT has_function(
  'api',
  'ui_reverse_finance_event_v1',
  ARRAY['jsonb'],
  'api.ui_reverse_finance_event_v1(jsonb) browser wrapper is registered'
);

SELECT ok(has_function_privilege('authenticated', 'api.ui_record_cod_remittance_v1(jsonb)', 'EXECUTE'), 'authenticated can execute API COD remittance wrapper');
SELECT ok(has_function_privilege('authenticated', 'api.ui_adjust_cod_collection_v1(jsonb)', 'EXECUTE'), 'authenticated can execute API COD adjustment wrapper');
SELECT ok(has_function_privilege('authenticated', 'api.ui_reverse_finance_event_v1(jsonb)', 'EXECUTE'), 'authenticated can execute API ledger reversal wrapper');
SELECT ok(NOT has_function_privilege('anon', 'api.ui_record_cod_remittance_v1(jsonb)', 'EXECUTE'), 'anon cannot execute API COD remittance wrapper');
SELECT ok(NOT has_function_privilege('anon', 'api.ui_adjust_cod_collection_v1(jsonb)', 'EXECUTE'), 'anon cannot execute API COD adjustment wrapper');
SELECT ok(NOT has_function_privilege('anon', 'api.ui_reverse_finance_event_v1(jsonb)', 'EXECUTE'), 'anon cannot execute API ledger reversal wrapper');
SELECT ok(
  to_regprocedure('public.ui_record_cod_remittance_v1_pre_cod_scope_guard_v1(jsonb)') IS NOT NULL
    AND NOT has_function_privilege(
      'authenticated',
      to_regprocedure('public.ui_record_cod_remittance_v1_pre_cod_scope_guard_v1(jsonb)'),
      'EXECUTE'
    ),
  'authenticated cannot bypass guarded COD remittance wrapper'
);
SELECT ok(
  to_regprocedure('public.ui_adjust_cod_collection_v1_pre_cod_scope_guard_v1(jsonb)') IS NOT NULL
    AND NOT has_function_privilege(
      'authenticated',
      to_regprocedure('public.ui_adjust_cod_collection_v1_pre_cod_scope_guard_v1(jsonb)'),
      'EXECUTE'
    ),
  'authenticated cannot bypass guarded COD adjustment wrapper'
);

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-00000000c950';
  v_branch uuid := '00000000-0000-0000-0000-00000000c951';
  v_batch uuid := '00000000-0000-0000-0000-00000000c952';
  v_billing_batch uuid := '00000000-0000-0000-0000-00000000c956';
  v_shipment_action_id uuid := '00000000-0000-0000-0000-00000000c958';
  v_shipment uuid := '00000000-0000-0000-0000-00000000c955';
  v_client uuid := '00000000-0000-0000-0000-00000000c959';
  v_ops_admin uuid := '00000000-0000-0000-0000-00000000c953';
  v_sender_user uuid := '00000000-0000-0000-0000-00000000c954';
  v_finance_event uuid;
  v_non_cod_finance_event uuid;
  v_finance_at timestamptz;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W84 COD Closeout Org', 'w84-cod-closeout-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'w84-cod', 'W84 COD Branch')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_admin,
    v_org,
    'w84-cod-closeout-ops@example.com',
    'W84 COD Closeout Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_sender_user,
    v_org,
    'w84-cod-closeout-sender@example.com',
    'W84 COD Closeout Sender',
    'account_manager',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, account_manager_id, sla_tier, status)
  VALUES (
    v_client,
    v_org,
    'W84 COD Closeout Client',
    'w84-cod-closeout-client',
    v_sender_user,
    'standard',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id,
    subject_type, subject_id, status, version, metadata
  )
  VALUES (
    v_batch,
    v_org,
    'cod',
    'branch_day',
    v_branch,
    'branch',
    v_branch,
    'open',
    1,
    jsonb_build_object('currency', 'SAR')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id,
    subject_type, subject_id, status, version, metadata
  )
  VALUES (
    v_billing_batch,
    v_org,
    'billing',
    'branch_day',
    v_branch,
    'branch',
    v_branch,
    'open',
    1,
    jsonb_build_object('currency', 'SAR')
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT finance_event_id
    INTO v_finance_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', v_org,
    'event_type', 'cod_collected',
    'direction', 'in',
    'amount', 125,
    'currency', 'SAR',
    'account_type', 'driver',
    'account_id', v_ops_admin,
      'subject_type', 'shipment',
    'subject_id', v_shipment,
    'idempotency_key', 'w84-cod-closeout-original',
    'metadata', jsonb_build_object('tracking', 'W84-COD-1')
  ))
  LIMIT 1;

  SELECT finance_event_id
    INTO v_non_cod_finance_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', v_org,
    'event_type', 'charge',
    'direction', 'in',
    'amount', 77,
    'currency', 'SAR',
    'account_type', 'branch',
    'account_id', v_branch,
    'subject_type', 'billing_invoice',
    'subject_id', '00000000-0000-0000-0000-00000000c957',
    'idempotency_key', 'w84-cod-closeout-non-cod',
    'metadata', jsonb_build_object('source', 'pgtap')
  ))
  LIMIT 1;

  SELECT fe.occurred_at
    INTO v_finance_at
    FROM public.finance_events fe
   WHERE fe.id = v_finance_event
     AND fe.organization_id = v_org
   LIMIT 1;

  PERFORM set_config('test.w84c_org', v_org::text, true);
  PERFORM set_config('test.w84c_branch', v_branch::text, true);
  PERFORM set_config('test.w84c_batch', v_batch::text, true);
  PERFORM set_config('test.w84c_billing_batch', v_billing_batch::text, true);
  PERFORM set_config('test.w84c_shipment_action', v_shipment_action_id::text, true);
  PERFORM set_config('test.w84c_shipment', v_shipment::text, true);
  PERFORM set_config('test.w84c_client', v_client::text, true);
  PERFORM set_config('test.w84c_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.w84c_sender_user', v_sender_user::text, true);
  PERFORM set_config('test.w84c_finance_event', v_finance_event::text, true);
  PERFORM set_config('test.w84c_non_cod_finance_event', v_non_cod_finance_event::text, true);
  PERFORM set_config('test.w84c_finance_at', v_finance_at::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_ops_admin'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (
    SELECT (api.ui_record_cod_remittance_v1(jsonb_build_object(
      'settlement_batch_id', current_setting('test.w84c_batch'),
      'cod_entry_id', current_setting('test.w84c_finance_event'),
      'amount', 100,
      'currency', 'SAR',
      'reason', 'cashier counted and accepted'
    ))->>'ok')::boolean
  ),
  'ops_admin can record COD remittance through API wrapper'
);

RESET ROLE;
SET LOCAL ROLE postgres;
SELECT is(
  (
    SELECT count(*)::int
      FROM public.finance_events fe
     WHERE fe.organization_id = current_setting('test.w84c_org')::uuid
       AND fe.event_type = 'cod_handover'
       AND fe.metadata->>'transfer_id' IS NOT NULL
  ),
  2,
  'COD remittance appends paired finance_events'
);
SELECT is(
  (
    SELECT count(*)::int
      FROM public.settlement_batch_finance_events sbfe
     WHERE sbfe.organization_id = current_setting('test.w84c_org')::uuid
       AND sbfe.settlement_batch_id = current_setting('test.w84c_batch')::uuid
  ),
  2,
  'COD remittance attaches paired finance_events to the settlement batch'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_adjust_cod_collection_v1(jsonb_build_object(
      'cod_entry_id', current_setting('test.w84c_finance_event'),
      'adjustment_amount', -15,
      'currency', 'SAR',
      'reason', 'cashier correction after recount'
    ))->>'ok')::boolean
  ),
  'ops_admin can append COD collected amount adjustment'
);
RESET ROLE;

SET LOCAL ROLE postgres;
DO $$
DECLARE
  v_org uuid := current_setting('test.w84c_org')::uuid;
  v_branch uuid := current_setting('test.w84c_branch')::uuid;
  v_client uuid := current_setting('test.w84c_client')::uuid;
  v_shipment_action_id uuid := current_setting('test.w84c_shipment_action')::uuid;
  v_shipment uuid := '00000000-0000-0000-0000-00000000c955';
  v_route_run uuid := '00000000-0000-0000-0000-00000000c956';
  v_route_stop uuid := '00000000-0000-0000-0000-00000000c957';
BEGIN
  INSERT INTO public.shipments (
    id, organization_id, client_id, service_type, tracking_number,
    box_count, cod_amount, cod_currency, status, branch_id, driver_user_id
  )
  VALUES (
    v_shipment,
    v_org,
    v_client,
    'delivery',
    'W84-COD-ACTION',
    1,
    125,
    'SAR',
    'delivered',
    v_branch,
    current_setting('test.w84c_ops_admin')::uuid
  )
  ON CONFLICT (id, client_id) DO UPDATE
    SET cod_amount = EXCLUDED.cod_amount,
        cod_currency = EXCLUDED.cod_currency,
        status = EXCLUDED.status,
        branch_id = EXCLUDED.branch_id,
        driver_user_id = EXCLUDED.driver_user_id;

  INSERT INTO public.route_runs (
    id, organization_id, branch_id, driver_user_id, status, planned_date
  )
  VALUES (
    v_route_run,
    v_org,
    v_branch,
    current_setting('test.w84c_ops_admin')::uuid,
    'completed',
    current_date
  )
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        branch_id = EXCLUDED.branch_id,
        driver_user_id = EXCLUDED.driver_user_id,
        status = EXCLUDED.status;

  INSERT INTO public.route_stops (
    id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order
  )
  VALUES (
    v_route_stop,
    v_org,
    v_route_run,
    v_client,
    v_shipment,
    'delivery',
    1
  )
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        route_run_id = EXCLUDED.route_run_id,
        client_id = EXCLUDED.client_id,
        shipment_id = EXCLUDED.shipment_id,
        stop_kind = EXCLUDED.stop_kind,
        sequence_order = EXCLUDED.sequence_order;

  INSERT INTO public.shipment_actions (
    id, shipment_id, action_type, action_category, canonical_status,
    timestamp, organization_id, client_id, action_data,
    performed_by_user_id
  )
  VALUES (
    v_shipment_action_id,
    v_shipment,
    'delivery_completed',
    'delivery',
    'delivered',
    now(),
    v_org,
    v_client,
    jsonb_build_object(
      'route_stop_id', v_route_stop,
      'delivery_completion', jsonb_build_object(
        'route_stop_id', v_route_stop,
        'payment_collection', jsonb_build_object(
          'outcome', 'collected',
          'method', 'cash',
          'expected_amount', 125,
          'collected_amount', 125,
          'variance_amount', 0,
          'currency', 'SAR',
          'has_discrepancy', false
        )
      )
    ),
    current_setting('test.w84c_ops_admin')::uuid
  )
  ON CONFLICT (id) DO UPDATE
    SET action_data = EXCLUDED.action_data,
        performed_by_user_id = EXCLUDED.performed_by_user_id;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_record_cod_remittance_v1(jsonb_build_object(
      'cod_entry_id', current_setting('test.w84c_shipment_action'),
      'amount', 25,
      'currency', 'SAR',
      'reason', 'cashier action row handover'
    ))->>'ok')::boolean
  ),
  'ops_admin can record COD remittance from shipment_action payment collection id'
);
RESET ROLE;

SET LOCAL ROLE postgres;
SELECT is(
  (
    SELECT (metadata->>'remitted')::numeric
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  25::numeric,
  'COD entries counts only the received side of paired direct handover finance events without double-counting settlement membership'
);
SELECT is(
  (
    SELECT metadata->>'branch_id'
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  current_setting('test.w84c_branch'),
  'COD entries projects shipment branch context for settlement starts'
);
SELECT is(
  (
    SELECT metadata->>'driver_user_id'
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  current_setting('test.w84c_ops_admin'),
  'COD entries projects shipment driver context for settlement starts'
);
SELECT is(
  (
    SELECT metadata->>'settlement_context_ready'
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  'true',
  'COD entries marks settlement context ready when branch and driver are present'
);
UPDATE public.shipments
   SET driver_user_id = NULL
 WHERE id = current_setting('test.w84c_shipment')::uuid
   AND organization_id = current_setting('test.w84c_org')::uuid;
SELECT is(
  (
    SELECT metadata->>'settlement_context_ready'
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  'false',
  'COD entries marks settlement context not ready when driver context is missing'
);
UPDATE public.shipments
   SET driver_user_id = current_setting('test.w84c_ops_admin')::uuid
 WHERE id = current_setting('test.w84c_shipment')::uuid
   AND organization_id = current_setting('test.w84c_org')::uuid;
SELECT is(
  (
    SELECT (public.compute_cod_payment_collection_summary_v1(
      current_setting('test.w84c_org')::uuid,
      current_setting('test.w84c_branch')::uuid,
      'driver',
      current_setting('test.w84c_ops_admin')::uuid,
      now() - interval '1 hour',
      now() + interval '1 hour'
    )->>'remitted_amount')::numeric
  ),
  25::numeric,
  'COD summary exposes remitted_amount for no-reload KPI readback'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT is(
  (
    SELECT (api.compute_cod_payment_collection_summary_v1(
      current_setting('test.w84c_org')::uuid,
      current_setting('test.w84c_branch')::uuid,
      'driver',
      current_setting('test.w84c_ops_admin')::uuid,
      now() - interval '1 hour',
      now() + interval '1 hour'
    )->>'remitted_amount')::numeric
  ),
  25::numeric,
  'api COD summary wrapper exposes remitted_amount for browser KPI readback'
);
RESET ROLE;

SET LOCAL ROLE postgres;
DO $$
DECLARE
  v_batch uuid := '00000000-0000-0000-0000-00000000c95a';
  v_finance_event uuid;
  v_from_finance_event uuid;
  v_finance_at timestamptz;
  v_from_finance_at timestamptz;
BEGIN
  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id,
    subject_type, subject_id, status, version, metadata
  )
  VALUES (
    v_batch,
    current_setting('test.w84c_org')::uuid,
    'cod',
    'branch_day',
    current_setting('test.w84c_branch')::uuid,
    'branch',
    current_setting('test.w84c_branch')::uuid,
    'approved',
    1,
    jsonb_build_object(
      'currency', 'SAR',
      'shipment_id', current_setting('test.w84c_shipment'),
      'cod_entry_id', current_setting('test.w84c_shipment_action'),
      'tracking', 'W84-COD-1'
    )
  )
  ON CONFLICT (id) DO UPDATE
    SET metadata = EXCLUDED.metadata;

  SELECT finance_event_id
    INTO v_finance_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', current_setting('test.w84c_org')::uuid,
    'event_type', 'cod_handover',
    'direction', 'in',
    'amount', 30,
    'currency', 'SAR',
    'account_type', 'branch',
    'account_id', current_setting('test.w84c_branch')::uuid,
    'subject_type', 'settlement_batch',
    'subject_id', v_batch,
    'idempotency_key', 'w84-cod-closeout-settlement-batch-ledger',
    'metadata', jsonb_build_object(
      'side', 'to',
      'transfer_id', 'w84-settlement-batch-ledger',
      'actor_system', 'pgtap'
    )
  ))
  LIMIT 1;

  SELECT occurred_at
    INTO v_finance_at
  FROM public.finance_events
  WHERE organization_id = current_setting('test.w84c_org')::uuid
    AND id = v_finance_event
  LIMIT 1;

  SELECT finance_event_id
    INTO v_from_finance_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', current_setting('test.w84c_org')::uuid,
    'event_type', 'cod_handover',
    'direction', 'out',
    'amount', 30,
    'currency', 'SAR',
    'account_type', 'driver',
    'account_id', current_setting('test.w84c_ops_admin')::uuid,
    'subject_type', 'settlement_batch',
    'subject_id', v_batch,
    'idempotency_key', 'w84-cod-closeout-settlement-batch-ledger-from',
    'metadata', jsonb_build_object(
      'side', 'from',
      'transfer_id', 'w84-settlement-batch-ledger',
      'actor_system', 'pgtap'
    )
  ))
  LIMIT 1;

  SELECT occurred_at
    INTO v_from_finance_at
  FROM public.finance_events
  WHERE organization_id = current_setting('test.w84c_org')::uuid
    AND id = v_from_finance_event
  LIMIT 1;

  INSERT INTO public.settlement_batch_finance_events (
    settlement_batch_id,
    organization_id,
    finance_event_id,
    finance_occurred_at,
    created_at
  )
  VALUES (
    v_batch,
    current_setting('test.w84c_org')::uuid,
    v_finance_event,
    v_finance_at,
    now()
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.settlement_batch_finance_events (
    settlement_batch_id,
    organization_id,
    finance_event_id,
    finance_occurred_at,
    created_at
  )
  VALUES (
    v_batch,
    current_setting('test.w84c_org')::uuid,
    v_from_finance_event,
    v_from_finance_at,
    now()
  )
  ON CONFLICT DO NOTHING;
END $$;

SELECT is(
  (
    SELECT (metadata->>'remitted')::numeric
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  55::numeric,
  'COD entries includes settlement-batch-subject finance events linked back to the shipment'
);
SELECT is(
  (
    SELECT (public.compute_cod_payment_collection_summary_v1(
      current_setting('test.w84c_org')::uuid,
      current_setting('test.w84c_branch')::uuid,
      'driver',
      current_setting('test.w84c_ops_admin')::uuid,
      now() - interval '1 hour',
      now() + interval '1 hour'
    )->>'remitted_amount')::numeric
  ),
  55::numeric,
  'COD summary includes settlement-batch-subject finance events linked back to the shipment'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT is(
  (
    SELECT (api.compute_cod_payment_collection_summary_v1(
      current_setting('test.w84c_org')::uuid,
      current_setting('test.w84c_branch')::uuid,
      'driver',
      current_setting('test.w84c_ops_admin')::uuid,
      now() - interval '1 hour',
      now() + interval '1 hour'
    )->>'remitted_amount')::numeric
  ),
  55::numeric,
  'api COD summary wrapper includes settlement-batch-subject remittance for browser KPI readback'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_adjust_cod_collection_v1(jsonb_build_object(
      'cod_entry_id', current_setting('test.w84c_shipment_action'),
      'adjustment_amount', 5,
      'currency', 'SAR',
      'reason', 'cashier action row correction'
    ))->>'ok')::boolean
  ),
  'ops_admin can adjust COD collection from shipment_action payment collection id'
);
RESET ROLE;

SET LOCAL ROLE postgres;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.finance_events fe
     WHERE fe.organization_id = current_setting('test.w84c_org')::uuid
       AND fe.event_type = 'adjustment'
       AND fe.direction = 'out'
       AND fe.amount = 15
       AND fe.metadata->>'adjustment_type' = 'cod_collected_amount'
  ),
  'COD adjustment is append-only adjustment event with inverse direction for negative delta'
);
SELECT is(
  (
    SELECT (metadata->>'collected')::numeric
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  115::numeric,
  'COD entries applies net signed collected-amount adjustments for no-reload row readback'
);
SELECT is(
  (
    SELECT (metadata->>'discrepancy')::numeric
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  -10::numeric,
  'COD entries exposes net adjusted discrepancy after collected-amount correction'
);
SELECT is(
  (
    SELECT metadata->>'status'
      FROM public.cod_entries
     WHERE id = current_setting('test.w84c_shipment_action')::uuid
  ),
  'shortfall',
  'COD entries moves adjusted rows into variance state for visible operator follow-up'
);
SELECT is(
  (
    SELECT (public.compute_cod_payment_collection_summary_v1(
      current_setting('test.w84c_org')::uuid,
      current_setting('test.w84c_branch')::uuid,
      'driver',
      current_setting('test.w84c_ops_admin')::uuid,
      now() - interval '1 hour',
      now() + interval '1 hour'
    )->>'collected_amount')::numeric
  ),
  115::numeric,
  'COD summary applies net signed collected-amount adjustments for no-reload KPI readback'
);
SELECT is(
  (
    SELECT (public.compute_cod_payment_collection_summary_v1(
      current_setting('test.w84c_org')::uuid,
      current_setting('test.w84c_branch')::uuid,
      'driver',
      current_setting('test.w84c_ops_admin')::uuid,
      now() - interval '1 hour',
      now() + interval '1 hour'
    )->>'variance_amount')::numeric
  ),
  -10::numeric,
  'COD summary exposes adjusted variance for the variance KPI'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_record_cod_remittance_v1(jsonb_build_object(
       'cod_entry_id', current_setting('test.w84c_non_cod_finance_event'),
       'amount', 10,
       'currency', 'SAR',
       'reason', 'non cod event should fail'
     )) $$,
  '23514',
  NULL,
  'COD remittance rejects non-COD finance_event input'
);
SELECT throws_ok(
  $$ SELECT api.ui_record_cod_remittance_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.w84c_billing_batch'),
       'cod_entry_id', current_setting('test.w84c_finance_event'),
       'amount', 10,
       'currency', 'SAR',
       'reason', 'non cod batch should fail'
     )) $$,
  '23514',
  NULL,
  'COD remittance rejects non-COD settlement batch input'
);
SELECT throws_ok(
  $$ SELECT api.ui_adjust_cod_collection_v1(jsonb_build_object(
       'cod_entry_id', current_setting('test.w84c_non_cod_finance_event'),
       'adjustment_amount', 5,
       'currency', 'SAR',
       'reason', 'non cod event should fail'
     )) $$,
  '23514',
  NULL,
  'COD collection adjustment rejects non-COD finance_event input'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_reverse_finance_event_v1(jsonb_build_object(
      'finance_event_id', current_setting('test.w84c_finance_event'),
      'finance_occurred_at', current_setting('test.w84c_finance_at'),
      'reason', 'duplicate original ledger entry'
    ))->>'ok')::boolean
  ),
  'ops_admin can append finance ledger reversal'
);
RESET ROLE;

SET LOCAL ROLE postgres;
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.finance_events fe
     WHERE fe.organization_id = current_setting('test.w84c_org')::uuid
       AND fe.event_type = 'adjustment'
       AND fe.direction = 'out'
       AND fe.amount = 125
       AND fe.metadata->>'reverses_finance_event_id' = current_setting('test.w84c_finance_event')
  ),
  'ledger reversal appends inverse adjustment and preserves original ledger row'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84c_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_reverse_finance_event_v1(jsonb_build_object(
       'finance_event_id', current_setting('test.w84c_finance_event'),
       'finance_occurred_at', current_setting('test.w84c_finance_at'),
       'reason', 'not allowed for sender'
     )) $$,
  '42501',
  NULL,
  'non-finance user cannot reverse ledger events'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
