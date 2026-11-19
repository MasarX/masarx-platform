-- pgTAP: Console V2 COD closeout denies lower-permission users before
-- finance-event or settlement-batch side effects.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

CREATE OR REPLACE FUNCTION pg_temp.test_console_v2_cod_closeout_write_denied_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_batch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_limited UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_cod_event UUID := NULL;
  v_events_before INT := 0;
  v_batch_links_before INT := 0;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT has_function('public', 'ui_record_cod_remittance_v1', ARRAY['jsonb'], 'public.ui_record_cod_remittance_v1 exists');
  RETURN NEXT has_function('api', 'ui_record_cod_remittance_v1', ARRAY['jsonb'], 'api.ui_record_cod_remittance_v1 exists');
  RETURN NEXT has_function('public', 'ui_adjust_cod_collection_v1', ARRAY['jsonb'], 'public.ui_adjust_cod_collection_v1 exists');
  RETURN NEXT has_function('api', 'ui_adjust_cod_collection_v1', ARRAY['jsonb'], 'api.ui_adjust_cod_collection_v1 exists');

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'COD Closeout Denied Org', 'cod-closeout-denied-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'ccd-' || lower(left(v_org::text, 6)), 'COD Closeout Denied Branch');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'cod-closeout-ops-' || left(v_ops::text, 8) || '@example.com', 'COD Closeout Ops', 'ops_admin', 'active', 'tenant', NULL),
    (v_limited, v_org, 'cod-closeout-limited-' || left(v_limited::text, 8) || '@example.com', 'COD Closeout Limited', 'account_manager', 'active', 'tenant', NULL);

  INSERT INTO public.clients (id, organization_id, name, slug, account_manager_id, sla_tier, status)
  VALUES (v_client, v_org, 'COD Closeout Denied Client', 'cod-closeout-denied-client-' || left(v_client::text, 8), v_limited, 'standard', 'active');

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id, subject_type, subject_id, status, version, metadata
  )
  VALUES (
    v_batch, v_org, 'cod', 'branch_day', v_branch, 'branch', v_branch, 'open', 1,
    jsonb_build_object('currency', 'SAR')
  );

  SELECT finance_event_id
    INTO v_cod_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', v_org,
    'event_type', 'cod_collected',
    'direction', 'in',
    'amount', 125,
    'currency', 'SAR',
    'account_type', 'driver',
    'account_id', v_ops,
    'subject_type', 'shipment',
    'subject_id', v_shipment,
    'idempotency_key', 'cod-closeout-denied-source-' || v_org::text,
    'metadata', jsonb_build_object('tracking', 'COD-DENIED-1')
  ))
  LIMIT 1;

  SELECT count(*)::int
    INTO v_events_before
    FROM public.finance_events
   WHERE organization_id = v_org;

  SELECT count(*)::int
    INTO v_batch_links_before
    FROM public.settlement_batch_finance_events
   WHERE organization_id = v_org;

  PERFORM set_config('request.jwt.claim.sub', v_limited::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT throws_ok(
    format(
      $sql$SELECT public.ui_record_cod_remittance_v1(jsonb_build_object(
        'settlement_batch_id', %L,
        'cod_entry_id', %L,
        'amount', 25,
        'currency', 'SAR',
        'reason', 'limited cashier handover'
      ))$sql$,
      v_batch::text,
      v_cod_event::text
    ),
    '42501',
    NULL,
    'limited user denied public COD remittance'
  );
  RETURN NEXT throws_ok(
    format(
      $sql$SELECT api.ui_record_cod_remittance_v1(jsonb_build_object(
        'settlement_batch_id', %L,
        'cod_entry_id', %L,
        'amount', 25,
        'currency', 'SAR',
        'reason', 'limited cashier handover'
      ))$sql$,
      v_batch::text,
      v_cod_event::text
    ),
    '42501',
    NULL,
    'limited user denied API COD remittance'
  );
  RETURN NEXT throws_ok(
    format(
      $sql$SELECT public.ui_adjust_cod_collection_v1(jsonb_build_object(
        'cod_entry_id', %L,
        'adjustment_amount', -5,
        'currency', 'SAR',
        'reason', 'limited cashier correction'
      ))$sql$,
      v_cod_event::text
    ),
    '42501',
    NULL,
    'limited user denied public COD adjustment'
  );
  RETURN NEXT throws_ok(
    format(
      $sql$SELECT api.ui_adjust_cod_collection_v1(jsonb_build_object(
        'cod_entry_id', %L,
        'adjustment_amount', -5,
        'currency', 'SAR',
        'reason', 'limited cashier correction'
      ))$sql$,
      v_cod_event::text
    ),
    '42501',
    NULL,
    'limited user denied API COD adjustment'
  );

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (
      SELECT count(*)::int
        FROM public.finance_events
       WHERE organization_id = v_org
    ),
    v_events_before,
    'denied COD closeout writes append no finance_events'
  );
  RETURN NEXT is(
    (
      SELECT count(*)::int
        FROM public.settlement_batch_finance_events
       WHERE organization_id = v_org
    ),
    v_batch_links_before,
    'denied COD closeout writes append no settlement batch links'
  );
  RETURN NEXT is(
    (
      SELECT count(*)::int
        FROM public.finance_events
       WHERE organization_id = v_org
         AND event_type = 'cod_handover'
    ),
    0,
    'denied COD remittance writes no cod_handover events'
  );
  RETURN NEXT is(
    (
      SELECT count(*)::int
        FROM public.finance_events
       WHERE organization_id = v_org
         AND event_type = 'adjustment'
         AND metadata->>'adjustment_type' = 'cod_collected_amount'
    ),
    0,
    'denied COD adjustment writes no adjustment event'
  );
  RETURN NEXT is(
    (
      SELECT amount
        FROM public.finance_events
       WHERE id = v_cod_event
    ),
    125::numeric,
    'source COD collection amount is unchanged after denied attempts'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  RETURN NEXT ok(
    (
      SELECT (api.ui_record_cod_remittance_v1(jsonb_build_object(
        'settlement_batch_id', v_batch::text,
        'cod_entry_id', v_cod_event::text,
        'amount', 25,
        'currency', 'SAR',
        'reason', 'ops cashier handover'
      ))->>'ok')::boolean
    ),
    'ops user can record COD remittance through API wrapper'
  );
  RETURN NEXT ok(
    (
      SELECT (api.ui_adjust_cod_collection_v1(jsonb_build_object(
        'cod_entry_id', v_cod_event::text,
        'adjustment_amount', -5,
        'currency', 'SAR',
        'reason', 'ops cashier correction'
      ))->>'ok')::boolean
    ),
    'ops user can adjust COD collection through API wrapper'
  );

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (
      SELECT count(*)::int
        FROM public.finance_events
       WHERE organization_id = v_org
         AND event_type = 'cod_handover'
    ),
    2,
    'allowed COD remittance appends paired cod_handover events'
  );
  RETURN NEXT is(
    (
      SELECT count(*)::int
        FROM public.finance_events
       WHERE organization_id = v_org
         AND event_type = 'adjustment'
         AND metadata->>'adjustment_type' = 'cod_collected_amount'
    ),
    1,
    'allowed COD adjustment appends one adjustment event'
  );
  RETURN NEXT is(
    (
      SELECT count(*)::int
        FROM public.settlement_batch_finance_events
       WHERE organization_id = v_org
         AND settlement_batch_id = v_batch
    ),
    2,
    'allowed COD remittance links paired events to settlement batch'
  );

  EXECUTE 'RESET ROLE';
END;
$function$;

SELECT * FROM pg_temp.test_console_v2_cod_closeout_write_denied_state_v1();

SELECT * FROM finish();
ROLLBACK;
