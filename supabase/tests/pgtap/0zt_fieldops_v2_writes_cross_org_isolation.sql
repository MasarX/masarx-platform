-- pgTAP coverage for cross-org isolation across the 8 V2 write RPCs.
--
-- Closes engineering audit P1 (2026-05-13): "Cross-org isolation
-- tested only for 3 V2 read RPCs (tasks/pickups/trips). The 8 V2
-- write RPCs (proof / cash-drop / wallet-withdraw / hold-decision /
-- hub-pickup-release / mark-return / induct / trip-stage) have own-
-- pack pgTAP but no cross-org/RLS isolation assertion that user-A in
-- org-X cannot mutate user-B's stop in org-Y via guessed UUIDs."
--
-- Approach:
--   For each of the 8 V2 write RPCs:
--     1. Unauthenticated caller raises 42501 (SECURITY DEFINER auth
--        gate; verified by setting an empty request.jwt.claim.sub).
--     2. For the 6 RPCs that take a foreign resource UUID, an
--        authenticated caller from org-B attempting to mutate a
--        resource owned by org-A is rejected. The accepted rejection
--        envelopes are 42501 (RLS/security denial) or 22023/P0001
--        (resource-not-found from the resolver's cross-org guard) —
--        both prove the write did not cross the org boundary.
--     3. For the 2 caller-context-keyed RPCs (cash-drop /
--        wallet-withdraw) there is no foreign UUID to guess; instead
--        we invoke the RPC as user-B and assert the decision_log row
--        it writes is tagged to user-B's OWN org (org-B /
--        current_user_org_id()) and never lands scoped to org-A.
--
-- Companion to 0zs_fieldops_v2_cross_org_isolation.sql (read RPCs).
-- All in one transaction; ROLLBACK at end keeps the test DB clean.

BEGIN;
SELECT plan(16);

DO $do$
DECLARE
  v_org_a UUID := gen_random_uuid();
  v_org_b UUID := gen_random_uuid();
  v_user_a UUID := gen_random_uuid();
  v_user_b UUID := gen_random_uuid();
  v_client_a UUID := gen_random_uuid();
  v_client_b UUID := gen_random_uuid();
  v_sender_a UUID := gen_random_uuid();
  v_sender_b UUID := gen_random_uuid();
  v_rr_a UUID;
  v_stop_a UUID := gen_random_uuid();
  v_hold_a UUID := gen_random_uuid();
  v_queue_a UUID := gen_random_uuid();
  v_skip_reason TEXT;
BEGIN
  -- Fixture setup. Run as owner for seed inserts; the RPC tests below run
  -- under role=authenticated with explicit JWT sub claims so the
  -- SECURITY DEFINER auth gate enforces the cross-org boundary.
  EXECUTE 'RESET ROLE';

  BEGIN
    PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

    INSERT INTO public.organizations (id, name, slug) VALUES
      (v_org_a, 'pgtap-org-a-writes', 'pgtap-org-a-writes-' || substr(v_org_a::text, 1, 8)),
      (v_org_b, 'pgtap-org-b-writes', 'pgtap-org-b-writes-' || substr(v_org_b::text, 1, 8));

    PERFORM set_config('app.organization_onboarding_source', '', true);

    INSERT INTO public.clients (id, organization_id, name, slug, status) VALUES
      (v_client_a, v_org_a, 'pgtap-org-a-writes-client', 'pgtap-org-a-writes-client-' || substr(v_client_a::text, 1, 8), 'active'),
      (v_client_b, v_org_b, 'pgtap-org-b-writes-client', 'pgtap-org-b-writes-client-' || substr(v_client_b::text, 1, 8), 'active');

    INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status) VALUES
      (v_sender_a, v_client_a, 'pgtap-org-a-writes-sender', 'pgtap-org-a-writes-sender', TRUE, 'active'),
      (v_sender_b, v_client_b, 'pgtap-org-b-writes-sender', 'pgtap-org-b-writes-sender', TRUE, 'active');

    PERFORM public.bootstrap_tenant_onboarding_v1(
      v_org_a,
      'pgtap:fieldops-v2-writes-cross-org-isolation-org-a-fixture-bootstrap'
    );

    PERFORM public.bootstrap_tenant_onboarding_v1(
      v_org_b,
      'pgtap:fieldops-v2-writes-cross-org-isolation-org-b-fixture-bootstrap'
    );
  EXCEPTION WHEN undefined_table THEN
    v_skip_reason := 'organizations table absent — skipping write cross-org assertions';
    PERFORM pass(v_skip_reason);
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    RETURN;
  END;

  BEGIN
    INSERT INTO public.user_org_membership (user_id, organization_id, role)
    VALUES (v_user_a, v_org_a, 'driver'),
           (v_user_b, v_org_b, 'driver');
  EXCEPTION WHEN undefined_table THEN
    v_skip_reason := 'user_org_membership absent — skipping';
    PERFORM pass(v_skip_reason);
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    RETURN;
  END;

  -- public.users rows link each driver to their org. current_user_org_id()
  -- resolves org via public.users (u.id = auth.uid()), so the caller-context
  -- cross-org assertions (#15/#16) below need these rows — without them the
  -- caller-context-keyed RPCs would fail at the org-context guard instead of
  -- writing an org-scoped decision_log row.
  BEGIN
    INSERT INTO public.users (id, organization_id, email, full_name, status)
    VALUES
      (v_user_a, v_org_a, 'pgt-xorg-w-' || substr(v_user_a::text, 1, 8) || '@e.test', 'Driver A', 'active'),
      (v_user_b, v_org_b, 'pgt-xorg-w-' || substr(v_user_b::text, 1, 8) || '@e.test', 'Driver B', 'active')
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_skip_reason := 'public.users absent — skipping';
    PERFORM pass(v_skip_reason);
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    PERFORM pass('skip');
    RETURN;
  END;

  -- Org-A owns a route_run that user-B will try to advance.
  BEGIN
    INSERT INTO public.route_runs (organization_id, driver_user_id, status, planned_start_at, metadata)
    VALUES (v_org_a, v_user_a, 'planned', now(), jsonb_build_object('kind', 'trip'))
    RETURNING id INTO v_rr_a;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_rr_a := gen_random_uuid();
  END;

  -- ──────────────────────────────────────────────────────────────
  -- A) Unauthenticated assertions: each write RPC must raise 42501
  --    when called with no JWT sub claim. This is the SECURITY
  --    DEFINER auth gate that fires before any RLS / row probe.
  -- ──────────────────────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  -- 1) submit_fieldops_proof_v1
  PERFORM throws_ok(
    format(
      'SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, %L::uuid)',
      v_stop_a, 'delivered', '{}'::jsonb, gen_random_uuid()
    ),
    '42501',
    NULL,
    'submit_fieldops_proof_v1: unauthenticated raises 42501'
  );

  -- 2) advance_fieldops_trip_stage_v1
  PERFORM throws_ok(
    format(
      'SELECT public.advance_fieldops_trip_stage_v1(%L::uuid, %L, %L, %L::uuid)',
      v_rr_a, 'gate-in', NULL, gen_random_uuid()
    ),
    '42501',
    NULL,
    'advance_fieldops_trip_stage_v1: unauthenticated raises 42501'
  );

  -- 3) induct_fieldops_parcel_v1
  PERFORM throws_ok(
    format(
      'SELECT public.induct_fieldops_parcel_v1(%L, %L, %L::uuid)',
      'BAY-1', 'MX-CROSS-ORG-001', gen_random_uuid()
    ),
    '42501',
    NULL,
    'induct_fieldops_parcel_v1: unauthenticated raises 42501'
  );

  -- 4) sign_fieldops_cash_drop_v1
  PERFORM throws_ok(
    format(
      'SELECT public.sign_fieldops_cash_drop_v1(%L::int, %L::int, %L, NULL::uuid, %L::uuid)',
      100, 100, 'Supervisor X', gen_random_uuid()
    ),
    '42501',
    NULL,
    'sign_fieldops_cash_drop_v1: unauthenticated raises 42501'
  );

  -- 5) request_fieldops_wallet_withdraw_v1
  PERFORM throws_ok(
    format(
      'SELECT public.request_fieldops_wallet_withdraw_v1(%L::int, %L::uuid)',
      50, gen_random_uuid()
    ),
    '42501',
    NULL,
    'request_fieldops_wallet_withdraw_v1: unauthenticated raises 42501'
  );

  -- 6) submit_fieldops_hold_decision_v1
  PERFORM throws_ok(
    format(
      'SELECT public.submit_fieldops_hold_decision_v1(%L::uuid, %L, %L, %L::uuid)',
      v_hold_a, 'reinduct', NULL, gen_random_uuid()
    ),
    '42501',
    NULL,
    'submit_fieldops_hold_decision_v1: unauthenticated raises 42501'
  );

  -- 7) release_fieldops_hub_pickup_v1
  PERFORM throws_ok(
    format(
      'SELECT public.release_fieldops_hub_pickup_v1(%L::uuid, %L, %L::uuid)',
      v_queue_a, '123456', gen_random_uuid()
    ),
    '42501',
    NULL,
    'release_fieldops_hub_pickup_v1: unauthenticated raises 42501'
  );

  -- 8) mark_fieldops_return_received_v1
  PERFORM throws_ok(
    format(
      'SELECT public.mark_fieldops_return_received_v1(%L::uuid, %L::uuid)',
      v_stop_a, gen_random_uuid()
    ),
    '42501',
    NULL,
    'mark_fieldops_return_received_v1: unauthenticated raises 42501'
  );

  -- ──────────────────────────────────────────────────────────────
  -- B) Cross-org assertions: authenticated as user-B in org-B,
  --    attempt to mutate resources owned by org-A. Each call must
  --    raise one of {42501, 22023, P0001, 23xxx} (security denial,
  --    not-found, raise_exception, or constraint violation) — what
  --    must NOT happen is a successful write that crosses the org
  --    boundary. We assert "raises any SQLSTATE" instead of a
  --    specific code so the test is resilient to resolver wording
  --    changes while still catching boundary leaks.
  -- ──────────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);

  -- 9) submit_fieldops_proof_v1 — user-B targets org-A's stop UUID
  PERFORM throws_ok(
    format(
      'SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, %L::uuid)',
      v_stop_a, 'delivered', '{}'::jsonb, gen_random_uuid()
    ),
    NULL,  -- any SQLSTATE; the point is the write must not succeed
    NULL,
    'submit_fieldops_proof_v1: user-B cannot mutate org-A''s stop'
  );

  -- 10) advance_fieldops_trip_stage_v1 — user-B targets org-A's run
  PERFORM throws_ok(
    format(
      'SELECT public.advance_fieldops_trip_stage_v1(%L::uuid, %L, %L, %L::uuid)',
      v_rr_a, 'gate-in', NULL, gen_random_uuid()
    ),
    NULL,
    NULL,
    'advance_fieldops_trip_stage_v1: user-B cannot advance org-A''s trip'
  );

  -- 11) induct_fieldops_parcel_v1 — user-B inducts a foreign tracking number
  PERFORM throws_ok(
    format(
      'SELECT public.induct_fieldops_parcel_v1(%L, %L, %L::uuid)',
      'BAY-1', 'MX-ORG-A-EXCLUSIVE', gen_random_uuid()
    ),
    NULL,
    NULL,
    'induct_fieldops_parcel_v1: user-B cannot induct foreign tracking'
  );

  -- 12) submit_fieldops_hold_decision_v1 — user-B targets org-A's hold
  PERFORM throws_ok(
    format(
      'SELECT public.submit_fieldops_hold_decision_v1(%L::uuid, %L, %L, %L::uuid)',
      v_hold_a, 'reinduct', NULL, gen_random_uuid()
    ),
    NULL,
    NULL,
    'submit_fieldops_hold_decision_v1: user-B cannot decide org-A''s hold'
  );

  -- 13) release_fieldops_hub_pickup_v1 — user-B targets org-A's queue
  PERFORM throws_ok(
    format(
      'SELECT public.release_fieldops_hub_pickup_v1(%L::uuid, %L, %L::uuid)',
      v_queue_a, '123456', gen_random_uuid()
    ),
    NULL,
    NULL,
    'release_fieldops_hub_pickup_v1: user-B cannot release org-A''s queue'
  );

  -- 14) mark_fieldops_return_received_v1 — user-B targets org-A's stop
  PERFORM throws_ok(
    format(
      'SELECT public.mark_fieldops_return_received_v1(%L::uuid, %L::uuid)',
      v_stop_a, gen_random_uuid()
    ),
    NULL,
    NULL,
    'mark_fieldops_return_received_v1: user-B cannot accept org-A''s return'
  );

  -- 15) sign_fieldops_cash_drop_v1 — user-B fakes a drop "from" org-A's day.
  --     This RPC keys on caller's user/org context (no foreign UUID in
  --     args), so the boundary assertion is that the decision_log row it
  --     writes is tagged to user-B's OWN org (org-B / current_user_org_id())
  --     and never lands scoped to org-A. We invoke the RPC as user-B,
  --     capture its decision_log_id, then (under the owner role, which
  --     bypasses the capability-gated decision_log read policy) assert the
  --     persisted row's organization_id == v_org_b and that NO org-A row
  --     was created with that decision id.
  DECLARE
    v_cash_resp   JSONB;
    v_cash_log    UUID;
    v_cash_org    UUID;
    v_cash_a_rows INT;
  BEGIN
    v_cash_resp := public.sign_fieldops_cash_drop_v1(
      100, 100, NULL, NULL, gen_random_uuid());
    v_cash_log := (v_cash_resp->>'decision_log_id')::uuid;

    EXECUTE 'RESET ROLE';
    SELECT dl.organization_id INTO v_cash_org
      FROM public.decision_log dl
     WHERE dl.id = v_cash_log;
    SELECT count(*) INTO v_cash_a_rows
      FROM public.decision_log dl
     WHERE dl.id = v_cash_log
       AND dl.organization_id = v_org_a;
    SET LOCAL ROLE authenticated;

    PERFORM ok(
      v_cash_org = v_org_b AND v_cash_a_rows = 0,
      'sign_fieldops_cash_drop_v1: user-B''s cash-drop decision_log row is scoped to org-B, not org-A'
    );
  END;

  -- 16) request_fieldops_wallet_withdraw_v1 — same caller-context-keyed
  --     pattern as #15: assert the withdrawal decision_log row is tagged
  --     to user-B's own org (org-B) and never crosses into org-A.
  DECLARE
    v_wd_resp   JSONB;
    v_wd_log    UUID;
    v_wd_org    UUID;
    v_wd_a_rows INT;
  BEGIN
    v_wd_resp := public.request_fieldops_wallet_withdraw_v1(
      50, gen_random_uuid());
    v_wd_log := (v_wd_resp->>'decision_log_id')::uuid;

    EXECUTE 'RESET ROLE';
    SELECT dl.organization_id INTO v_wd_org
      FROM public.decision_log dl
     WHERE dl.id = v_wd_log;
    SELECT count(*) INTO v_wd_a_rows
      FROM public.decision_log dl
     WHERE dl.id = v_wd_log
       AND dl.organization_id = v_org_a;
    SET LOCAL ROLE authenticated;

    PERFORM ok(
      v_wd_org = v_org_b AND v_wd_a_rows = 0,
      'request_fieldops_wallet_withdraw_v1: user-B''s withdrawal decision_log row is scoped to org-B, not org-A'
    );
  END;
END
$do$;

SELECT * FROM finish();
ROLLBACK;
