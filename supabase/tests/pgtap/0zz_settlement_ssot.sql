-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S95
-- pgTAP: Settlement SSOT invariants (idempotency + projection)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(24);

-- Service-only RPCs should not be executable by authenticated.
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.create_settlement_batch_v1(jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE create_settlement_batch_v1'
);

SELECT ok(
  NOT has_table_privilege('service_role', 'public.settlement_events', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.settlement_events', 'DELETE')
  AND NOT has_table_privilege('service_role', 'public.settlement_batch_finance_events', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.settlement_batch_finance_events', 'DELETE'),
  'service_role has no direct mutation privileges on immutable settlement ledgers'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_ops_session RECORD;

  v_create_1 RECORD;
  v_create_2 RECORD;
  v_transition_1 RECORD;
  v_transition_2 RECORD;

  v_fin RECORD;
  v_attach_1 RECORD;
  v_attach_2 RECORD;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Settlement SSOT Org', 'settlement-ssot-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'b-' || left(v_branch::text, 8), 'Branch');

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Client', 'client-' || left(v_client::text, 8));

  INSERT INTO public.senders (id, client_id, name)
  VALUES (v_sender, v_client, 'Sender');

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_driver, v_org, 'settlement-driver-' || left(v_driver::text, 8) || '@example.com', 'Settlement Driver', 'tenant');

  -- RBAC: ops sessions are permission-gated; grant driver role to the settlement actor.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_ops_session
    FROM public.open_ops_session_v1(jsonb_build_object(
      'session_type', 'driver_shift',
      'idempotency_key', 'pgtap-settlement-ops-session-1',
      'branch_id', v_branch
    ))
   LIMIT 1;

  PERFORM ok(v_ops_session.ops_session_id IS NOT NULL, 'open_ops_session_v1 creates an ops session for settlement provenance');

  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_create_1
    FROM public.create_settlement_batch_v1(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'cod',
      'scope_type', 'driver_shift',
      'branch_id', v_branch,
      'client_id', v_client,
      'sender_id', v_sender,
      'subject_type', 'driver',
      'subject_id', v_driver,
      'idempotency_key', 'pgtap-settlement-create-1',
      'metadata', jsonb_build_object('source', 'pgtap')
    ))
   LIMIT 1;

  SELECT *
    INTO v_create_2
    FROM public.create_settlement_batch_v1(jsonb_build_object(
      'organization_id', v_org,
      'kind', 'cod',
      'scope_type', 'driver_shift',
      'branch_id', v_branch,
      'client_id', v_client,
      'sender_id', v_sender,
      'subject_type', 'driver',
      'subject_id', v_driver,
      'idempotency_key', 'pgtap-settlement-create-1'
    ))
   LIMIT 1;

  PERFORM is(v_create_1.settlement_batch_id::text, v_create_2.settlement_batch_id::text, 'create_settlement_batch_v1 idempotency returns same settlement_batch_id');
  PERFORM is(v_create_1.settlement_event_id::text, v_create_2.settlement_event_id::text, 'create_settlement_batch_v1 idempotency returns same settlement_event_id');
  PERFORM ok(v_create_1.created IS TRUE, 'create_settlement_batch_v1 returns created=true on first call');
  PERFORM ok(v_create_2.created IS FALSE, 'create_settlement_batch_v1 returns created=false on idempotent replay');

  PERFORM is(
    (SELECT COUNT(*)::INT FROM public.settlement_batches WHERE organization_id = v_org AND idempotency_key = 'pgtap-settlement-create-1'),
    1,
    'create_settlement_batch_v1 does not duplicate settlement_batches for same idempotency_key'
  );

  SELECT *
    INTO v_fin
    FROM public.record_finance_event_v1(jsonb_build_object(
      'organization_id', v_org,
      'event_type', 'cod_collected',
      'direction', 'in',
      'amount', 100,
      'currency', 'SAR',
      'account_type', 'driver',
      'account_id', v_driver,
      'idempotency_key', 'pgtap-finance-1',
      'metadata', jsonb_build_object('source', 'pgtap')
    ))
   LIMIT 1;

  PERFORM ok(v_fin.created IS TRUE, 'record_finance_event_v1 returns created=true on first call');

  SELECT *
    INTO v_attach_1
    FROM public.attach_finance_event_to_settlement_v1(jsonb_build_object(
      'settlement_batch_id', v_create_1.settlement_batch_id,
      'finance_event_id', v_fin.finance_event_id,
      'idempotency_key', 'pgtap-attach-1',
      'payload', jsonb_build_object('source', 'pgtap')
    ))
   LIMIT 1;

  SELECT *
    INTO v_attach_2
    FROM public.attach_finance_event_to_settlement_v1(jsonb_build_object(
      'settlement_batch_id', v_create_1.settlement_batch_id,
      'finance_event_id', v_fin.finance_event_id,
      'idempotency_key', 'pgtap-attach-1',
      'payload', jsonb_build_object('source', 'pgtap')
    ))
   LIMIT 1;

  PERFORM is(v_attach_1.settlement_event_id::text, v_attach_2.settlement_event_id::text, 'attach_finance_event_to_settlement_v1 idempotency returns same settlement_event_id');
  PERFORM ok(v_attach_1.attached IS TRUE, 'attach_finance_event_to_settlement_v1 returns attached=true on first call');
  PERFORM ok(v_attach_2.attached IS TRUE, 'attach_finance_event_to_settlement_v1 returns attached=true on idempotent replay');

  SELECT *
    INTO v_transition_1
    FROM public.transition_settlement_batch_v1(jsonb_build_object(
      'settlement_batch_id', v_create_1.settlement_batch_id,
      'to_status', 'locked',
      'status_reason', 'pgtap',
      'idempotency_key', 'pgtap-settlement-transition-1',
      'ops_session_id', v_ops_session.ops_session_id
    ))
   LIMIT 1;

  SELECT *
    INTO v_transition_2
    FROM public.transition_settlement_batch_v1(jsonb_build_object(
      'settlement_batch_id', v_create_1.settlement_batch_id,
      'to_status', 'locked',
      'status_reason', 'pgtap',
      'idempotency_key', 'pgtap-settlement-transition-1'
    ))
   LIMIT 1;

  PERFORM is(v_transition_1.settlement_event_id::text, v_transition_2.settlement_event_id::text, 'transition_settlement_batch_v1 idempotency returns same settlement_event_id');
  PERFORM is((SELECT status FROM public.settlement_batches WHERE id = v_create_1.settlement_batch_id), 'locked', 'transition_settlement_batch_v1 updates projection status');
  PERFORM is((SELECT version FROM public.settlement_batches WHERE id = v_create_1.settlement_batch_id)::INT, 3, 'transition_settlement_batch_v1 idempotency increments version once');

  PERFORM is(
    (SELECT ops_session_id::text FROM public.settlement_events WHERE id = v_transition_1.settlement_event_id),
    v_ops_session.ops_session_id::text,
    'transition_settlement_batch_v1 stores ops_session_id on settlement_events'
  );

  PERFORM throws_ok(
    format($sql$
      SELECT *
        FROM public.attach_finance_event_to_settlement_v1(jsonb_build_object(
          'settlement_batch_id', %L::uuid,
          'finance_event_id', %L::uuid,
          'idempotency_key', 'pgtap-attach-after-lock',
          'payload', jsonb_build_object('source', 'pgtap')
        ))
       LIMIT 1
    $sql$, v_create_1.settlement_batch_id, v_fin.finance_event_id),
    '23514',
    'attach_finance_event_to_settlement_v1 not allowed in status: locked'
  );

  PERFORM is(
    (SELECT COUNT(*)::INT FROM public.settlement_batch_finance_events WHERE settlement_batch_id = v_create_1.settlement_batch_id),
    1,
    'settlement_batch_finance_events has 1 membership row'
  );

  PERFORM is(
    (SELECT version FROM public.settlement_batches WHERE id = v_create_1.settlement_batch_id)::INT,
    (SELECT MAX(batch_version)::INT FROM public.settlement_events WHERE settlement_batch_id = v_create_1.settlement_batch_id),
    'settlement_batches.version matches max(settlement_events.batch_version)'
  );

  PERFORM is(
    (SELECT COUNT(*)::INT FROM public.settlement_events WHERE settlement_batch_id = v_create_1.settlement_batch_id),
    3,
    'settlement_events has expected count'
  );

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.settlement_events WHERE settlement_batch_id = v_create_1.settlement_batch_id AND decision_log_id IS NOT NULL) = 3,
    'settlement_events rows link to decision_log_id'
  );

  PERFORM ok(
    (SELECT settings_resolution_id IS NOT NULL FROM public.settlement_events WHERE id = v_create_1.settlement_event_id),
    'create event records settings_resolution_id'
  );

  PERFORM throws_ok(
    format(
      $sql$
        UPDATE public.settlement_events
           SET payload = payload || jsonb_build_object('tampered', true)
         WHERE id = %L::uuid
      $sql$,
      v_transition_1.settlement_event_id
    ),
    '2F003',
    'settlement_events is append-only (immutable); use the canonical write path to add a new row instead'
  );

  PERFORM throws_ok(
    format(
      $sql$
        DELETE FROM public.settlement_batch_finance_events
         WHERE settlement_batch_id = %L::uuid
           AND finance_event_id = %L::uuid
      $sql$,
      v_create_1.settlement_batch_id,
      v_fin.finance_event_id
    ),
    '2F003',
    'settlement_batch_finance_events is append-only (immutable); use the canonical write path to add a new row instead'
  );
END $$;

SELECT * FROM finish();

ROLLBACK;
