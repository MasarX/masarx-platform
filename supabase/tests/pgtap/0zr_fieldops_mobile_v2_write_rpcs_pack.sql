-- pgTAP coverage for Mobile V2 fieldops write-side RPCs
-- (submit_fieldops_proof_v1, advance_fieldops_trip_stage_v1,
--  induct_fieldops_parcel_v1, sign_fieldops_cash_drop_v1,
--  request_fieldops_wallet_withdraw_v1, submit_fieldops_hold_decision_v1,
--  release_fieldops_hub_pickup_v1, mark_fieldops_return_received_v1)
--
-- Assertions per RPC:
--   - existence in public.*       (8)
--   - existence in api.*          (8)
--   - SECDEF on public.*          (8)
--   - grants (no anon, has auth)  (8)
--   - happy-path call             (8)
--   - 42501 unauthenticated guard (8)
--   - invalid-input / transition  (8)
--   - idempotent replay (proof + wallet)         (2)
--   plan(58) — 8 existence(public) + 8 existence(api) + 8 SECDEF
--              + 8 grants + 8 happy-path + 8 unauthenticated 42501
--              + 8 invalid-input + 2 idempotent replay

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(122);

WITH named_first_tenant AS (
  SELECT o.id
    FROM public.organizations o
   WHERE o.name ILIKE 'First Tenant Readiness Logistics%'
     AND o.id <> '00000000-0000-0000-0000-000000000000'::uuid
   ORDER BY o.created_at DESC, o.id
   LIMIT 1
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'mobile_loader_policy'
       AND (
         s.cached_value#>>'{session_context,bay}' = 'FT-LIVE-BAY-01'
         OR s.cached_value#>>'{session_context,wave_label}' = 'FT-LIVE-WAVE'
         OR s.cached_value#>>'{session_context,route_label}' = 'FT-LIVE-ROUTE'
       )
       AND (
         NOT EXISTS (SELECT 1 FROM named_first_tenant)
         OR s.scope_type IS DISTINCT FROM 'tenant'
         OR s.scope_id IS DISTINCT FROM (SELECT id FROM named_first_tenant)
       )
  ),
  'mobile_loader_policy FT-LIVE session context is scoped only to the first tenant'
);

WITH named_first_tenant AS (
  SELECT o.id
    FROM public.organizations o
   WHERE o.name ILIKE 'First Tenant Readiness Logistics%'
     AND o.id <> '00000000-0000-0000-0000-000000000000'::uuid
   ORDER BY o.created_at DESC, o.id
   LIMIT 1
)
SELECT ok(
  NOT EXISTS (SELECT 1 FROM named_first_tenant)
  OR EXISTS (
    SELECT 1
      FROM named_first_tenant ft
      JOIN public.settings s
        ON s.category = 'mobile_loader_policy'
       AND s.scope_type = 'tenant'
       AND s.scope_id = ft.id
     WHERE s.cached_value#>>'{session_context,bay}' = 'FT-LIVE-BAY-01'
       AND s.cached_value#>>'{session_context,wave_label}' = 'FT-LIVE-WAVE'
       AND s.cached_value#>>'{session_context,route_label}' = 'FT-LIVE-ROUTE'
  ),
  'first tenant has tenant-scoped Mobile V2 loader session context'
);

WITH first_tenant AS (
  SELECT candidate.id
    FROM (
      SELECT o.id, 0 AS priority, o.created_at
        FROM public.organizations o
       WHERE o.name ILIKE 'First Tenant Readiness Logistics%'
         AND o.id <> '00000000-0000-0000-0000-000000000000'::uuid
      UNION ALL
      SELECT o.id, 1 AS priority, o.created_at
        FROM public.organizations o
       WHERE o.name = 'Test Organization Alpha'
         AND o.id <> '00000000-0000-0000-0000-000000000000'::uuid
      UNION ALL
      SELECT o.id, 2 AS priority, o.created_at
        FROM public.organizations o
       WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    ) AS candidate
   ORDER BY candidate.priority, candidate.created_at DESC, candidate.id
   LIMIT 1
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM first_tenant ft
      CROSS JOIN LATERAL public.resolve_settings_row_from_policy_context_v1(
        'mobile_loader_policy',
        jsonb_build_object('organization_id', ft.id)
      ) r
     WHERE r.value->>'default_action' = 'sort'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(r.value->'actions') action
          WHERE action->>'key' = 'sort'
            AND action->>'submit_rpc' = 'induct_fieldops_parcel_v1'
       )
  ),
  'first tenant resolves sort loader action with induct_fieldops_parcel_v1 submit RPC'
);

-- ===========================================================================
-- A) Existence — public.*
-- ===========================================================================

SELECT has_function('public', 'submit_fieldops_proof_v1',
  ARRAY['uuid','text','jsonb','uuid'],
  'public.submit_fieldops_proof_v1 exists');

SELECT has_function('public', 'advance_fieldops_trip_stage_v1',
  ARRAY['uuid','text','text','uuid'],
  'public.advance_fieldops_trip_stage_v1 exists');

SELECT has_function('public', 'induct_fieldops_parcel_v1',
  ARRAY['text','text','uuid'],
  'public.induct_fieldops_parcel_v1 exists');

SELECT has_function('public', 'sign_fieldops_cash_drop_v1',
  ARRAY['integer','integer','text','uuid','uuid'],
  'public.sign_fieldops_cash_drop_v1 exists');

SELECT has_function('public', 'request_fieldops_wallet_withdraw_v1',
  ARRAY['integer','uuid'],
  'public.request_fieldops_wallet_withdraw_v1 exists');

SELECT has_function('public', 'submit_fieldops_hold_decision_v1',
  ARRAY['uuid','text','text','uuid'],
  'public.submit_fieldops_hold_decision_v1 exists');

SELECT has_function('public', 'release_fieldops_hub_pickup_v1',
  ARRAY['uuid','text','uuid'],
  'public.release_fieldops_hub_pickup_v1 exists');

SELECT has_function('public', 'mark_fieldops_return_received_v1',
  ARRAY['uuid','uuid'],
  'public.mark_fieldops_return_received_v1 exists');

-- ===========================================================================
-- B) Existence — api.* mirrors
-- ===========================================================================

SELECT has_function('api', 'submit_fieldops_proof_v1',
  ARRAY['uuid','text','jsonb','uuid'],
  'api.submit_fieldops_proof_v1 wrapper exists');

SELECT has_function('api', 'advance_fieldops_trip_stage_v1',
  ARRAY['uuid','text','text','uuid'],
  'api.advance_fieldops_trip_stage_v1 wrapper exists');

SELECT has_function('api', 'induct_fieldops_parcel_v1',
  ARRAY['text','text','uuid'],
  'api.induct_fieldops_parcel_v1 wrapper exists');

SELECT has_function('api', 'sign_fieldops_cash_drop_v1',
  ARRAY['integer','integer','text','uuid','uuid'],
  'api.sign_fieldops_cash_drop_v1 wrapper exists');

SELECT has_function('api', 'request_fieldops_wallet_withdraw_v1',
  ARRAY['integer','uuid'],
  'api.request_fieldops_wallet_withdraw_v1 wrapper exists');

SELECT has_function('api', 'submit_fieldops_hold_decision_v1',
  ARRAY['uuid','text','text','uuid'],
  'api.submit_fieldops_hold_decision_v1 wrapper exists');

SELECT has_function('api', 'release_fieldops_hub_pickup_v1',
  ARRAY['uuid','text','uuid'],
  'api.release_fieldops_hub_pickup_v1 wrapper exists');

SELECT has_function('api', 'mark_fieldops_return_received_v1',
  ARRAY['uuid','uuid'],
  'api.mark_fieldops_return_received_v1 wrapper exists');

SELECT has_function('api', 'auth_get_active_role_v1',
  ARRAY[]::text[],
  'api.auth_get_active_role_v1 wrapper exists for Mobile V2 exposed-schema clients');

SELECT has_function('api', 'auth_set_active_role_v1',
  ARRAY['text'],
  'api.auth_set_active_role_v1 wrapper exists for Mobile V2 exposed-schema clients');

-- ===========================================================================
-- C) SECURITY DEFINER on public.*
-- ===========================================================================

DO $$
DECLARE
  v_pairs TEXT[][] := ARRAY[
    ARRAY['submit_fieldops_proof_v1',           'submit_fieldops_proof_v1(uuid, text, jsonb, uuid)'],
    ARRAY['advance_fieldops_trip_stage_v1',     'advance_fieldops_trip_stage_v1(uuid, text, text, uuid)'],
    ARRAY['induct_fieldops_parcel_v1',          'induct_fieldops_parcel_v1(text, text, uuid)'],
    ARRAY['sign_fieldops_cash_drop_v1',         'sign_fieldops_cash_drop_v1(integer, integer, text, uuid, uuid)'],
    ARRAY['request_fieldops_wallet_withdraw_v1','request_fieldops_wallet_withdraw_v1(integer, uuid)'],
    ARRAY['submit_fieldops_hold_decision_v1',   'submit_fieldops_hold_decision_v1(uuid, text, text, uuid)'],
    ARRAY['release_fieldops_hub_pickup_v1',     'release_fieldops_hub_pickup_v1(uuid, text, uuid)'],
    ARRAY['mark_fieldops_return_received_v1',   'mark_fieldops_return_received_v1(uuid, uuid)']
  ];
  i INT;
  is_def BOOLEAN;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    SELECT p.prosecdef
      INTO is_def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_pairs[i][1]
     LIMIT 1;
    PERFORM ok(COALESCE(is_def, FALSE), format('public.%s is SECURITY DEFINER', v_pairs[i][1]));
  END LOOP;
END $$;

SELECT ok(
  has_function_privilege('authenticated', 'api.submit_fieldops_proof_v1(uuid, text, jsonb, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.submit_fieldops_proof_v1(uuid, text, jsonb, uuid)', 'EXECUTE'),
  'api.submit_fieldops_proof_v1: authenticated EXECUTE granted; anon revoked'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.auth_get_active_role_v1()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.auth_get_active_role_v1()', 'EXECUTE'),
  'api.auth_get_active_role_v1: authenticated EXECUTE granted; anon revoked'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.auth_set_active_role_v1(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.auth_set_active_role_v1(text)', 'EXECUTE'),
  'api.auth_set_active_role_v1: authenticated EXECUTE granted; anon revoked'
);

-- ===========================================================================
-- D) Grants: no anon EXECUTE, authenticated has EXECUTE on public.*
-- ===========================================================================

DO $$
DECLARE
  v_sigs TEXT[] := ARRAY[
    'submit_fieldops_proof_v1(uuid, text, jsonb, uuid)',
    'advance_fieldops_trip_stage_v1(uuid, text, text, uuid)',
    'induct_fieldops_parcel_v1(text, text, uuid)',
    'sign_fieldops_cash_drop_v1(integer, integer, text, uuid, uuid)',
    'request_fieldops_wallet_withdraw_v1(integer, uuid)',
    'submit_fieldops_hold_decision_v1(uuid, text, text, uuid)',
    'release_fieldops_hub_pickup_v1(uuid, text, uuid)',
    'mark_fieldops_return_received_v1(uuid, uuid)'
  ];
  s TEXT;
BEGIN
  FOREACH s IN ARRAY v_sigs LOOP
    PERFORM ok(
      has_function_privilege('authenticated', 'public.' || s, 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.' || s, 'EXECUTE'),
      format('public.%s: authenticated EXECUTE granted; anon revoked', s)
    );
  END LOOP;
END $$;

-- ===========================================================================
-- E) Unauthenticated 42501 — every write rejects when auth.uid() is NULL.
-- ===========================================================================

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', '{}', true);

  PERFORM throws_ok(
    'SELECT public.submit_fieldops_proof_v1(gen_random_uuid(), ''delivered'', ''{}''::jsonb, gen_random_uuid())',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.advance_fieldops_trip_stage_v1(gen_random_uuid(), ''gate-in'', NULL, gen_random_uuid())',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.induct_fieldops_parcel_v1(''BAY-A1'', ''TRACK-1'', gen_random_uuid())',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.sign_fieldops_cash_drop_v1(100, 100, NULL, NULL, gen_random_uuid())',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.request_fieldops_wallet_withdraw_v1(50, gen_random_uuid())',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.submit_fieldops_hold_decision_v1(gen_random_uuid(), ''reinduct'', NULL, gen_random_uuid())',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.release_fieldops_hub_pickup_v1(gen_random_uuid(), ''123456'', gen_random_uuid())',
    '42501'
  );
  PERFORM throws_ok(
    'SELECT public.mark_fieldops_return_received_v1(gen_random_uuid(), gen_random_uuid())',
    '42501'
  );
END $$;

-- ===========================================================================
-- F) Happy-path + invalid-input + idempotency — seeded fixture data.
-- ===========================================================================

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_run_single UUID := gen_random_uuid();
  v_stop UUID := gen_random_uuid();
  v_stop_done UUID := gen_random_uuid();
  v_stop_rto UUID := gen_random_uuid();
  v_stop_fail UUID := gen_random_uuid();
  v_stop_cod UUID := gen_random_uuid();
  v_stop_partial UUID := gen_random_uuid();
  v_stop_missing_artifact UUID := gen_random_uuid();
  v_stop_unregistered_artifact UUID := gen_random_uuid();
  v_stop_foreign_artifact UUID := gen_random_uuid();
  v_stop_autosync UUID := gen_random_uuid();
  v_stop_single UUID := gen_random_uuid();
  v_ship UUID := gen_random_uuid();
  v_ship2 UUID := gen_random_uuid();
  v_ship3 UUID := gen_random_uuid();
  v_ship4 UUID := gen_random_uuid();
  v_ship_cod UUID := gen_random_uuid();
  v_ship_partial UUID := gen_random_uuid();
  v_ship_missing_artifact UUID := gen_random_uuid();
  v_ship_unregistered_artifact UUID := gen_random_uuid();
  v_ship_foreign_artifact UUID := gen_random_uuid();
  v_ship_autosync UUID := gen_random_uuid();
  v_ship_single UUID := gen_random_uuid();
  v_task_type_route_stop UUID := gen_random_uuid();
  v_task_stop UUID := gen_random_uuid();
  v_task_stop_done UUID := gen_random_uuid();
  v_task_stop_fail UUID := gen_random_uuid();
  v_task_stop_cod UUID := gen_random_uuid();
  v_task_stop_partial UUID := gen_random_uuid();
  v_task_stop_missing_artifact UUID := gen_random_uuid();
  v_task_stop_unregistered_artifact UUID := gen_random_uuid();
  v_task_stop_foreign_artifact UUID := gen_random_uuid();
  v_task_stop_single UUID := gen_random_uuid();
  v_artifact_pod UUID := gen_random_uuid();
  v_artifact_pod_sig UUID := gen_random_uuid();
  v_artifact_cod UUID := gen_random_uuid();
  v_artifact_cod_sig UUID := gen_random_uuid();
  v_artifact_partial UUID := gen_random_uuid();
  v_artifact_partial_sig UUID := gen_random_uuid();
  v_artifact_foreign UUID := gen_random_uuid();
  v_artifact_unregistered UUID := gen_random_uuid();
  v_artifact_single UUID := gen_random_uuid();
  v_artifact_single_sig UUID := gen_random_uuid();
  v_artifact_missing_photo UUID := gen_random_uuid();
  v_artifact_autosync UUID := gen_random_uuid();
  v_artifact_autosync_sig UUID := gen_random_uuid();
  v_idem_proof UUID := gen_random_uuid();
  v_idem_proof_terminal UUID := gen_random_uuid();
  v_idem_proof_cod UUID := gen_random_uuid();
  v_idem_proof_partial UUID := gen_random_uuid();
  v_idem_proof_autosync UUID := gen_random_uuid();
  v_idem_proof_single UUID := gen_random_uuid();
  v_idem_advance UUID := gen_random_uuid();
  v_idem_advance_skip UUID := gen_random_uuid();
  v_idem_induct UUID := gen_random_uuid();
  v_idem_cash UUID := gen_random_uuid();
  v_idem_cash_bad UUID := gen_random_uuid();
  v_idem_wallet UUID := gen_random_uuid();
  v_idem_wallet_bad UUID := gen_random_uuid();
  v_idem_wallet_overdraw UUID := gen_random_uuid();
  v_idem_hold UUID := gen_random_uuid();
  v_idem_hold_bad UUID := gen_random_uuid();
  v_idem_pickup UUID := gen_random_uuid();
  v_idem_pickup_bad UUID := gen_random_uuid();
  v_idem_rto UUID := gen_random_uuid();
  v_idem_loader_session UUID := gen_random_uuid();
  v_hold_id UUID := gen_random_uuid();
  v_queue_id UUID := gen_random_uuid();
  v_resp JSONB;
  v_resp_proof JSONB;
  v_resp2 JSONB;
  v_stop_detail JSONB;
  v_cash_drop_readback JSONB;
  v_wallet_readback JSONB;
  v_returns_readback JSONB;
  v_sortation_readback JSONB;
  v_active_role_readback JSONB;
  v_loader_session_readback JSONB;
  v_loader_today JSONB;
  v_hold_readback JSONB;
BEGIN
  ------------------------------------------------------------------------
  -- Seed: org, user, client, branch, route_run, route_stops, shipments.
  ------------------------------------------------------------------------
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'pgTAP fieldops writes', 'pgt-fow-' || substr(v_org::text, 1, 8))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_other_org, 'pgTAP fieldops writes other', 'pgt-fow-other-' || substr(v_other_org::text, 1, 8))
  ON CONFLICT DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (v_driver, v_org, 'pgt-fow-d-' || substr(v_driver::text, 1, 8) || '@e.test', 'Driver', 'fieldops_money_driver', 'active')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Client', 'pgt-fow-c-' || substr(v_client::text, 1, 8))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Sender', 'Sender', TRUE, 'active')
  ON CONFLICT DO NOTHING;

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:fieldops-write-rpcs-fixture-bootstrap'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('source', 'fieldops_mobile_v2_pgtap')
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['warehouse_operator'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('source', 'fieldops_mobile_v2_loader_pgtap')
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'warehouse_operator'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
  VALUES (v_branch, v_org, 'Branch', 'pgt-fow-b-' || substr(v_branch::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at, metadata)
  VALUES
    (v_run, v_org, v_branch, v_driver, 'in_progress', CURRENT_DATE, now(),
     jsonb_build_object('stage', 'assigned', 'kind', 'linehaul')),
    (v_run_single, v_org, v_branch, v_driver, 'in_progress', CURRENT_DATE, now(),
     jsonb_build_object('stage', 'assigned', 'kind', 'single_stop_readback'))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number,
                                box_count, priority_score, status, status_updated_at)
  VALUES
    (v_ship,  v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship::text, 1, 8), '-', '')),  1, 50, 'pending', now()),
    (v_ship2, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship2::text, 1, 8), '-', '')), 1, 50, 'pending', now()),
    (v_ship3, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship3::text, 1, 8), '-', '')), 1, 50, 'pending', now()),
    (v_ship4, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship4::text, 1, 8), '-', '')), 1, 50, 'pending', now()),
    (v_ship_cod, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship_cod::text, 1, 8), '-', '')), 1, 50, 'pending', now()),
    (v_ship_partial, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship_partial::text, 1, 8), '-', '')), 3, 50, 'pending', now()),
    (v_ship_missing_artifact, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship_missing_artifact::text, 1, 8), '-', '')), 1, 50, 'pending', now()),
    (v_ship_unregistered_artifact, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship_unregistered_artifact::text, 1, 8), '-', '')), 1, 50, 'pending', now()),
    (v_ship_foreign_artifact, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship_foreign_artifact::text, 1, 8), '-', '')), 1, 50, 'pending', now()),
    (v_ship_autosync, v_org, v_client, v_sender, 'delivery', 'WB' || replace(substr(v_ship_autosync::text, 1, 8), '-', ''), 1, 50, 'pending', now()),
    (v_ship_single, v_org, v_client, v_sender, 'delivery', 'WB' || upper(replace(substr(v_ship_single::text, 1, 8), '-', '')), 1, 50, 'pending', now())
  ON CONFLICT DO NOTHING;

  UPDATE public.shipments
     SET cod_amount = 42.50,
         cod_currency = 'SAR'
   WHERE id = v_ship_cod;

  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind,
                                  sequence_order, planned_window_start_at, metadata)
  VALUES
    (v_stop,      v_org, v_run, v_client, v_ship,  'delivery', 1, now(), jsonb_build_object('status', 'pending')),
    (v_stop_done, v_org, v_run, v_client, v_ship2, 'delivery', 2, now(), jsonb_build_object('status', 'done')),
    (v_stop_rto,  v_org, v_run, v_client, v_ship3, 'delivery', 3, now(), jsonb_build_object('status', 'failed', 'customer_name', 'RTO Customer', 'parcels', 2, 'fail_reason', 'Customer refused')),
    (v_stop_fail, v_org, v_run, v_client, v_ship4, 'delivery', 4, now(), jsonb_build_object('status', 'open')),
    (v_stop_cod,  v_org, v_run, v_client, v_ship_cod, 'delivery', 5, now(), jsonb_build_object('status', 'pending', 'otp_code', '4821')),
    (v_stop_partial, v_org, v_run, v_client, v_ship_partial, 'delivery', 6, now(), jsonb_build_object('status', 'pending')),
    (v_stop_missing_artifact, v_org, v_run, v_client, v_ship_missing_artifact, 'delivery', 7, now(), jsonb_build_object('status', 'pending', 'otp_code', '4821')),
    (v_stop_unregistered_artifact, v_org, v_run, v_client, v_ship_unregistered_artifact, 'delivery', 8, now(), jsonb_build_object('status', 'pending')),
    (v_stop_foreign_artifact, v_org, v_run, v_client, v_ship_foreign_artifact, 'delivery', 9, now(), jsonb_build_object('status', 'pending')),
    (v_stop_autosync, v_org, v_run, v_client, v_ship_autosync, 'delivery', 10, now(), jsonb_build_object('status', 'pending')),
    (v_stop_single, v_org, v_run_single, v_client, v_ship_single, 'delivery', 1, now(), jsonb_build_object('status', 'pending'))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.task_types (id, organization_id, key, name, default_priority, default_queue_key, enabled, metadata)
  VALUES (v_task_type_route_stop, v_org, 'route_stop_execute', 'Route Stop Execute', 50, 'default', TRUE, '{}'::jsonb)
  ON CONFLICT (organization_id, key) DO UPDATE
  SET name = EXCLUDED.name
  RETURNING id INTO v_task_type_route_stop;

  INSERT INTO public.tasks (
    id, organization_id, client_id, sender_id, task_type_id, resource_type, resource_id,
    status, priority, queue_key, assigned_to, assigned_at, idempotency_key, metadata
  )
  VALUES
    (v_task_stop, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop::text, jsonb_build_object('route_run_id', v_run)),
    (v_task_stop_done, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop_done,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop_done::text, jsonb_build_object('route_run_id', v_run)),
    (v_task_stop_fail, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop_fail,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop_fail::text, jsonb_build_object('route_run_id', v_run)),
    (v_task_stop_cod, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop_cod,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop_cod::text, jsonb_build_object('route_run_id', v_run)),
    (v_task_stop_partial, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop_partial,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop_partial::text, jsonb_build_object('route_run_id', v_run)),
    (v_task_stop_missing_artifact, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop_missing_artifact,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop_missing_artifact::text, jsonb_build_object('route_run_id', v_run)),
    (v_task_stop_unregistered_artifact, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop_unregistered_artifact,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop_unregistered_artifact::text, jsonb_build_object('route_run_id', v_run)),
    (v_task_stop_foreign_artifact, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop_foreign_artifact,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop_foreign_artifact::text, jsonb_build_object('route_run_id', v_run)),
    (v_task_stop_single, v_org, v_client, v_sender, v_task_type_route_stop, 'route_stop', v_stop_single,
     'open', 50, 'default', v_driver, now(), 'pgt-fow-stop-' || v_stop_single::text, jsonb_build_object('route_run_id', v_run_single))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.artifacts (
    id, organization_id, storage_bucket, storage_key, mime_type, size_bytes, created_by_user_id, source_system, metadata
  )
  VALUES
    (v_artifact_pod, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_pod::text || '.jpg',
     'image/jpeg', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'photo', 'proof_type', 'photo', 'route_stop_id', v_stop::text)),
    (v_artifact_pod_sig, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_pod_sig::text || '.png',
     'image/png', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'signature', 'proof_type', 'sig', 'route_stop_id', v_stop::text)),
    (v_artifact_cod, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_cod::text || '.jpg',
     'image/jpeg', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'photo', 'proof_type', 'cod_receipt', 'route_stop_id', v_stop_cod::text)),
    (v_artifact_cod_sig, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_cod_sig::text || '.png',
     'image/png', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'signature', 'proof_type', 'sig', 'route_stop_id', v_stop_cod::text)),
    (v_artifact_partial, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_partial::text || '.jpg',
     'image/jpeg', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'photo', 'proof_type', 'photo', 'route_stop_id', v_stop_partial::text)),
    (v_artifact_partial_sig, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_partial_sig::text || '.png',
     'image/png', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'signature', 'proof_type', 'sig', 'route_stop_id', v_stop_partial::text)),
    (v_artifact_single, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_single::text || '.jpg',
     'image/jpeg', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'photo', 'proof_type', 'photo', 'route_stop_id', v_stop_single::text)),
    (v_artifact_single_sig, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_single_sig::text || '.png',
     'image/png', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'signature', 'proof_type', 'sig', 'route_stop_id', v_stop_single::text)),
    (v_artifact_missing_photo, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_missing_photo::text || '.jpg',
     'image/jpeg', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'photo', 'proof_type', 'photo', 'route_stop_id', v_stop_missing_artifact::text)),
    (v_artifact_autosync, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_autosync::text || '.jpg',
     'image/jpeg', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'photo', 'proof_type', 'photo', 'route_stop_id', v_stop_autosync::text)),
    (v_artifact_autosync_sig, v_org, 'fieldops-pod', 'pgtap/' || v_artifact_autosync_sig::text || '.png',
     'image/png', 128, v_driver, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'signature', 'proof_type', 'sig', 'route_stop_id', v_stop_autosync::text))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.artifacts (
    id, organization_id, storage_bucket, storage_key, mime_type, size_bytes, created_by_user_id, source_system, metadata
  )
  VALUES (
    v_artifact_foreign, v_other_org, 'fieldops-pod', 'pgtap/' || v_artifact_foreign::text || '.jpg',
    'image/jpeg', 128, NULL, 'fieldops_mobile_v2', jsonb_build_object('artifact_kind', 'photo', 'proof_type', 'photo', 'route_stop_id', v_stop_foreign_artifact::text)
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.shipment_holds (
    id, organization_id, parcel_id, reported_by_user_id, severity_id, status, note, photo_storage_path, metadata
  )
  VALUES (
    v_hold_id,
    v_org,
    gen_random_uuid(),
    v_driver,
    'crushed',
    'open',
    'pgTAP Mobile V2 hold decision readback',
    'pgtap/hold-decision.jpg',
    jsonb_build_object('source', '0zr_fieldops_mobile_v2_write_rpcs_pack')
  )
  ON CONFLICT DO NOTHING;

  ------------------------------------------------------------------------
  -- Authenticate as the driver.
  ------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_driver::text, 'role', 'authenticated')::text,
    true);

  v_active_role_readback := public.auth_get_active_role_v1();
  PERFORM ok(
    v_active_role_readback->'assigned_roles' ? 'loader',
    'auth_get_active_role_v1 exposes warehouse_operator as Mobile V2 loader persona'
  );
  v_active_role_readback := public.auth_set_active_role_v1('loader');
  PERFORM is(
    v_active_role_readback->>'active_role',
    'loader',
    'auth_set_active_role_v1 accepts loader persona via warehouse_operator metadata alias'
  );
  v_active_role_readback := api.auth_get_active_role_v1();
  PERFORM ok(
    v_active_role_readback->'assigned_roles' ? 'loader',
    'api.auth_get_active_role_v1 exposes warehouse_operator as Mobile V2 loader persona'
  );
  v_active_role_readback := api.auth_set_active_role_v1('loader');
  PERFORM is(
    v_active_role_readback->>'active_role',
    'loader',
    'api.auth_set_active_role_v1 accepts loader persona for exposed-schema Mobile V2 clients'
  );
  SELECT to_jsonb(s)
    INTO v_loader_session_readback
    FROM api.open_ops_session_v1(jsonb_build_object(
      'session_type', 'warehouse_scan',
      'idempotency_key', 'pgt-fieldops-loader-session-' || v_idem_loader_session::text,
      'session_code', 'PGLDR-' || substr(v_idem_loader_session::text, 1, 8),
      'metadata', jsonb_build_object(
        'bay', 'BAY-A1',
        'wave_label', 'Wave pgTAP',
        'route_label', 'Route pgTAP',
        'cut_off', '18:30'
      )
    )) s
   LIMIT 1;
  v_loader_today := api.resolve_fieldops_loader_today_v1('loader', '{}'::jsonb);
  PERFORM is(
    v_loader_today->>'bay',
    'BAY-A1',
    'api.resolve_fieldops_loader_today_v1 reads active loader bay from warehouse_scan ops_session'
  );
  PERFORM is(
    v_loader_today->>'wave_label',
    'Wave pgTAP',
    'api.resolve_fieldops_loader_today_v1 reads active loader wave from warehouse_scan ops_session'
  );
  PERFORM is(
    v_loader_today->>'active_ops_session_id',
    v_loader_session_readback->>'ops_session_id',
    'api.resolve_fieldops_loader_today_v1 exposes active warehouse_scan ops_session id for Mobile V2 restart hydration'
  );

  ------------------------------------------------------------------------
  -- 1) submit_fieldops_proof_v1 — happy path + idempotency + invalid.
  ------------------------------------------------------------------------
  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_missing_artifact,
           'delivered',
           jsonb_build_object('pod_methods', 'scan+photo+sig', 'captured_at', '2026-05-26T00:00:00Z')::text),
    '23514',
    'submit_fieldops_proof_v1: registered POD artifact_ids are required for photo/signature/id proof',
    'submit_fieldops_proof_v1 rejects delivered photo/signature POD without registered artifact_ids'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_unregistered_artifact,
           'delivered',
           jsonb_build_object('pod_methods', 'scan+photo+sig', 'artifact_ids', jsonb_build_array(v_artifact_unregistered))::text),
    '42501',
    'submit_fieldops_proof_v1: artifact_ids must reference current-tenant registered artifacts',
    'submit_fieldops_proof_v1 rejects unregistered artifact_ids'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_foreign_artifact,
           'delivered',
           jsonb_build_object('pod_methods', 'scan+photo+sig', 'artifact_ids', jsonb_build_array(v_artifact_foreign))::text),
    '42501',
    'submit_fieldops_proof_v1: artifact_ids must reference current-tenant registered artifacts',
    'submit_fieldops_proof_v1 rejects cross-tenant artifact_ids'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_missing_artifact,
           'delivered',
           jsonb_build_object(
             'pod_methods', 'scan+photo+sig',
             'artifact_ids', jsonb_build_array(v_artifact_missing_photo),
             'scan_codes', jsonb_build_array((SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship_missing_artifact))
           )::text),
    '23514',
    'submit_fieldops_proof_v1: sig POD proof requires a matching current-stop artifact',
    'submit_fieldops_proof_v1 rejects signature proof backed only by a photo artifact'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_missing_artifact,
           'delivered',
           jsonb_build_object(
             'pod_methods', 'scan+photo',
             'artifact_ids', jsonb_build_array(v_artifact_missing_photo)
           )::text),
    '23514',
    'submit_fieldops_proof_v1: scan POD proof requires backend barcode readback codes',
    'submit_fieldops_proof_v1 rejects scan proof without submitted barcode codes'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_missing_artifact,
           'delivered',
           jsonb_build_object(
             'pod_methods', 'scan+otp',
             'scan_codes', jsonb_build_array((SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship_missing_artifact)),
             'otp_code', '9999'
           )::text),
    '23514',
    'submit_fieldops_proof_v1: otp POD proof did not match backend OTP',
    'submit_fieldops_proof_v1 rejects OTP proof that does not match backend OTP'
  );

  v_resp := public.submit_fieldops_proof_v1(
    v_stop,
    'delivered',
    jsonb_build_object(
      'pod_methods', 'scan+photo+sig',
      'captured_at', '2026-05-25T00:00:00Z',
      'artifact_ids', jsonb_build_array(v_artifact_pod, v_artifact_pod_sig),
      'scan_codes', jsonb_build_array((SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship)),
      'pod', jsonb_build_object('artifact_ids', jsonb_build_array(v_artifact_pod, v_artifact_pod_sig))
    ),
    v_idem_proof
  );
  PERFORM ok(
    (v_resp ? 'decision_log_id') AND (v_resp->>'state') = 'done' AND (v_resp->>'ok')::boolean,
    'submit_fieldops_proof_v1 happy path returns state=done'
  );
  v_resp_proof := v_resp;
  PERFORM ok(
    (v_resp ? 'task_event_id') AND (v_resp ? 'workflow_run_id') AND (v_resp ? 'shipment_action_id') AND (v_resp->>'workflow_status') = 'completed',
    'submit_fieldops_proof_v1 returns canonical task/workflow/shipment_action closeout readback'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.tasks t
       WHERE t.id = v_task_stop
         AND t.status = 'completed'
         AND t.completed_at IS NOT NULL
    ),
    'submit_fieldops_proof_v1 completes the route_stop_execute task'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipment_actions sa
       WHERE sa.shipment_id = v_ship
         AND sa.action_data->>'task_event_id' = v_resp->>'task_event_id'
    ),
    'submit_fieldops_proof_v1 projects shipment_action through the workflow closeout path'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipments s
       WHERE s.id = v_ship
         AND s.status = 'delivered'
         AND s.delivered_at IS NOT NULL
    ),
    'submit_fieldops_proof_v1 projects delivered shipment status through canonical closeout'
  );

  v_resp := public.submit_fieldops_proof_v1(
    v_stop_autosync,
    'delivered',
    jsonb_build_object(
      'pod_methods', 'scan+photo+sig',
      'captured_at', '2026-05-25T00:05:00Z',
      'artifact_ids', jsonb_build_array(v_artifact_autosync, v_artifact_autosync_sig),
      'scan_codes', jsonb_build_array((SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship_autosync)),
      'pod', jsonb_build_object('artifact_ids', jsonb_build_array(v_artifact_autosync, v_artifact_autosync_sig))
    ),
    v_idem_proof_autosync
  );
  PERFORM ok(
    (v_resp ? 'task_id') AND (v_resp ? 'task_event_id') AND (v_resp->>'workflow_status') = 'completed',
    'submit_fieldops_proof_v1 auto-syncs a missing route_stop_execute task before closeout'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.id = (v_resp->>'task_id')::uuid
         AND tt.key = 'route_stop_execute'
         AND t.resource_type = 'route_stop'
         AND t.resource_id = v_stop_autosync
         AND t.assigned_to = v_driver
         AND t.status = 'completed'
         AND t.metadata->>'mobile_v2_task_sync' = 'true'
    ),
    'submit_fieldops_proof_v1 auto-synced task is assigned to driver and completed'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.task_events te
       WHERE te.id = (v_resp->>'task_event_id')::uuid
         AND te.task_id = (v_resp->>'task_id')::uuid
         AND te.to_status = 'completed'
    ),
    'submit_fieldops_proof_v1 auto-synced task has completed task event readback'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipment_boxes sb
        JOIN public.shipments s
          ON s.id = sb.shipment_id
       WHERE s.id = v_ship_autosync
         AND sb.box_number = 1
         AND sb.barcode = s.tracking_number || ':1'
         AND sb.barcode ~ '^[A-Za-z0-9][A-Za-z0-9-]*:[1-9][0-9]*$'
    ),
    'route-stop closeout preserves mixed-case tracking in shipment box barcode'
  );

  -- idempotency: same key returns same decision_log_id
  v_resp2 := public.submit_fieldops_proof_v1(
    v_stop,
    'delivered',
    jsonb_build_object(
      'pod_methods', 'scan+photo+sig',
      'captured_at', '2026-05-25T00:00:00Z',
      'artifact_ids', jsonb_build_array(v_artifact_pod, v_artifact_pod_sig),
      'scan_codes', jsonb_build_array((SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship)),
      'pod', jsonb_build_object('artifact_ids', jsonb_build_array(v_artifact_pod, v_artifact_pod_sig))
    ),
    v_idem_proof
  );
  PERFORM ok(
    (v_resp2->>'decision_log_id') = (v_resp_proof->>'decision_log_id'),
    'submit_fieldops_proof_v1 idempotent replay returns same decision_log_id'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.route_stops rs
       WHERE rs.id = v_stop
         AND rs.metadata #>> '{proof,scan}' = 'true'
         AND rs.metadata #>> '{proof,photo}' = 'true'
         AND rs.metadata #>> '{proof,sig}' = 'true'
    ),
    'submit_fieldops_proof_v1 persists POD proof flags for stop-detail readback'
  );

  v_stop_detail := public.resolve_fieldops_stop_detail_v1(
    v_stop,
    'driver',
    jsonb_build_object('correlation_id', v_idem_proof::text)
  );
  PERFORM ok(
    (
      SELECT COUNT(*) = 3
        FROM jsonb_array_elements(v_stop_detail->'proofChecklist') item
       WHERE item->>'key' IN ('scan', 'photo', 'sig')
         AND item->>'status' = 'done'
    ),
    'resolve_fieldops_stop_detail_v1 exposes committed POD proof flags for same-context readback'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) t
       WHERE t.task_id = 'stop:' || v_stop::text
         AND t.meta->>'route_stop_status' = 'done'
         AND t.cta = 'Done'
         AND t.tone = 'success'
    ),
    'resolve_fieldops_tasks_v1 exposes done status, CTA, and tone for Route tab readback'
  );

  v_resp := public.submit_fieldops_proof_v1(
    v_stop_cod,
    'delivered',
    jsonb_build_object(
      'pod_methods', 'scan+photo+sig+otp+cod',
      'captured_at', '2026-05-26T00:00:00Z',
      'artifact_ids', jsonb_build_array(v_artifact_cod, v_artifact_cod_sig),
      'scan_codes', jsonb_build_array((SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship_cod)),
      'otp_code', '4821',
      'pod', jsonb_build_object('artifact_ids', jsonb_build_array(v_artifact_cod, v_artifact_cod_sig)),
      'payment_method', 'cash',
      'payment_amount', 42.50,
      'payment_receipt_context', 'fieldops_mobile_v2_pgtap',
      'payment_collection', jsonb_build_object(
        'method', 'cash',
        'collected_amount', 42.50,
        'tendered_amount', 50.00,
        'change_due_amount', 7.50,
        'receipt_context', 'fieldops_mobile_v2_pgtap'
      )
    ),
    v_idem_proof_cod
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.route_stops rs
       WHERE rs.id = v_stop_cod
         AND rs.metadata #>> '{proof,cod}' = 'true'
         AND rs.metadata #>> '{proof,otp}' = 'true'
    ),
    'submit_fieldops_proof_v1 persists COD and OTP proof flags for COD stop readback'
  );
  PERFORM ok(
    (v_resp ? 'shipment_action_id') AND (v_resp->>'workflow_status') = 'completed',
    'submit_fieldops_proof_v1 COD path returns canonical closeout readback'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipment_actions sa
       WHERE sa.shipment_id = v_ship_cod
         AND sa.action_data #>> '{delivery_completion,payment_collection,method}' = 'cash'
         AND (sa.action_data #>> '{delivery_completion,payment_collection,collected_amount}')::numeric = 42.50
         AND (sa.action_data #>> '{delivery_completion,payment_collection,tendered_amount}')::numeric = 50.00
         AND (sa.action_data #>> '{delivery_completion,payment_collection,change_due_amount}')::numeric = 7.50
    ),
    'submit_fieldops_proof_v1 COD path projects payment collection, tendered amount, and change through shipment_action'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.route_stops rs
       WHERE rs.id = v_stop_cod
         AND NOT ((rs.metadata #> '{last_proof,evidence}') ? 'otp_code')
         AND rs.metadata #>> '{last_proof,evidence,otp,verified}' = 'true'
    ),
    'submit_fieldops_proof_v1 redacts OTP code while preserving verified OTP evidence'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipments s
       WHERE s.id = v_ship_cod
         AND s.status = 'delivered'
         AND s.metadata #>> '{delivery_completion,payment_collection,method}' = 'cash'
    ),
    'submit_fieldops_proof_v1 COD path projects shipment delivery completion metadata'
  );

  v_stop_detail := public.resolve_fieldops_stop_detail_v1(
    v_stop_cod,
    'driver',
    jsonb_build_object('correlation_id', v_idem_proof_cod::text)
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_stop_detail->'proofChecklist') item
       WHERE item->>'key' = 'cod'
         AND item->>'status' = 'done'
    ),
    'resolve_fieldops_stop_detail_v1 exposes committed COD proof for same-context readback'
  );
  PERFORM ok(
    v_stop_detail #>> '{paymentCollection,outcome}' = 'collected'
    AND (v_stop_detail #>> '{paymentCollection,expectedAmount}')::numeric = 42.50
    AND (v_stop_detail #>> '{paymentCollection,collectedAmount}')::numeric = 42.50
    AND (v_stop_detail #>> '{paymentCollection,tenderedAmount}')::numeric = 50.00
    AND (v_stop_detail #>> '{paymentCollection,changeDueAmount}')::numeric = 7.50
    AND v_stop_detail #>> '{paymentCollection,source}' = 'shipment_action',
    'resolve_fieldops_stop_detail_v1 exposes COD collection amounts for same-screen native readback'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_partial,
           'partial',
           jsonb_build_object(
             'pod_methods', 'scan+photo+sig',
             'captured_at', '2026-05-28T00:00:00Z',
             'artifact_ids', jsonb_build_array(v_artifact_partial, v_artifact_partial_sig),
             'scan_codes', jsonb_build_array(
               (SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship_partial),
               (SELECT s.tracking_number || ':999' FROM public.shipments s WHERE s.id = v_ship_partial)
             ),
             'delivered_box_numbers', jsonb_build_array(1, 999)
           )::text),
    '23514',
    'submit_fieldops_proof_v1: scan POD proof contains unexpected parcel barcode',
    'submit_fieldops_proof_v1 rejects partial POD scan codes outside the shipment box set'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_partial,
           'partial',
           jsonb_build_object(
             'pod_methods', 'scan+photo+sig',
             'captured_at', '2026-05-28T00:00:00Z',
             'artifact_ids', jsonb_build_array(v_artifact_partial, v_artifact_partial_sig),
             'scan_codes', jsonb_build_array(
               (SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship_partial),
               (SELECT s.tracking_number || ':2' FROM public.shipments s WHERE s.id = v_ship_partial),
               (SELECT s.tracking_number || ':3' FROM public.shipments s WHERE s.id = v_ship_partial)
             ),
             'delivered_box_numbers', jsonb_build_array(1, 2, 3)
           )::text),
    '23514',
    'submit_fieldops_proof_v1: partial scan proof must include a strict subset of parcel barcodes',
    'submit_fieldops_proof_v1 rejects partial POD when every parcel barcode is scanned'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_partial,
           'partial',
           jsonb_build_object(
             'pod_methods', 'scan+photo+sig',
             'captured_at', '2026-05-28T00:00:00Z',
             'artifact_ids', jsonb_build_array(v_artifact_partial, v_artifact_partial_sig),
             'scan_codes', jsonb_build_array((SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship_partial)),
             'delivered_box_numbers', jsonb_build_array(2)
           )::text),
    '23514',
    'submit_fieldops_proof_v1: scan_codes must match delivered_box_numbers',
    'submit_fieldops_proof_v1 rejects partial POD when scan codes and delivered box numbers diverge'
  );

  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, gen_random_uuid())',
           v_stop_partial,
           'partial',
           jsonb_build_object(
             'pod_methods', 'scan+photo+sig',
             'captured_at', '2026-05-28T00:00:00Z',
             'artifact_ids', jsonb_build_array(v_artifact_partial, v_artifact_partial_sig),
             'scan_codes', '[]'::jsonb,
             'delivered_box_numbers', '[]'::jsonb
           )::text),
    '23514',
    'submit_fieldops_proof_v1: scan POD proof requires backend barcode readback codes',
    'submit_fieldops_proof_v1 rejects partial POD with an empty delivered subset'
  );

  v_resp := public.submit_fieldops_proof_v1(
    v_stop_partial,
    'partial',
    jsonb_build_object(
      'pod_methods', 'scan+photo+sig',
      'captured_at', '2026-05-28T00:00:00Z',
      'artifact_ids', jsonb_build_array(v_artifact_partial, v_artifact_partial_sig),
      'scan_codes', jsonb_build_array(
        (SELECT s.tracking_number || ':1' FROM public.shipments s WHERE s.id = v_ship_partial),
        (SELECT s.tracking_number || ':2' FROM public.shipments s WHERE s.id = v_ship_partial)
      ),
      'delivered_box_numbers', jsonb_build_array(1, 2),
      'pod', jsonb_build_object(
        'artifact_ids', jsonb_build_array(v_artifact_partial, v_artifact_partial_sig),
        'delivered_box_numbers', jsonb_build_array(1, 2)
      ),
      'delivery_completion', jsonb_build_object('delivered_box_numbers', jsonb_build_array(1, 2))
    ),
    v_idem_proof_partial
  );
  PERFORM ok(
    (v_resp->>'state') = 'partial'
      AND (v_resp->>'workflow_status') = 'completed'
      AND (v_resp ? 'shipment_action_id'),
    'submit_fieldops_proof_v1 partial path returns canonical closeout readback'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.route_stops rs
       WHERE rs.id = v_stop_partial
         AND rs.metadata #>> '{status}' = 'partial'
         AND rs.metadata #>> '{last_proof,outcome}' = 'partial'
         AND rs.metadata #>> '{proof,scan}' = 'true'
         AND rs.metadata #>> '{proof,photo}' = 'true'
         AND rs.metadata #>> '{proof,sig}' = 'true'
    ),
    'submit_fieldops_proof_v1 partial path persists partial stop status and proof flags'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipments s
       WHERE s.id = v_ship_partial
         AND s.status = 'out_for_delivery'
         AND s.delivered_at IS NULL
    ),
    'submit_fieldops_proof_v1 partial path leaves shipment open for remaining boxes'
  );
  PERFORM ok(
    (SELECT COUNT(*)::int FROM public.shipment_boxes WHERE shipment_id = v_ship_partial AND status = 'delivered') = 2
      AND (SELECT COUNT(*)::int FROM public.shipment_boxes WHERE shipment_id = v_ship_partial AND status = 'pending') = 1,
    'submit_fieldops_proof_v1 partial path marks only delivered box subset'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipment_actions sa
       WHERE sa.shipment_id = v_ship_partial
         AND sa.id = (v_resp->>'shipment_action_id')::uuid
         AND sa.action_data #>> '{delivery_completion,completion_kind}' = 'partial'
         AND sa.action_data #> '{delivery_completion,delivered_box_numbers}' = '[1, 2]'::jsonb
    ),
    'submit_fieldops_proof_v1 partial path forwards delivered_box_numbers into route-stop closeout'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) t
       WHERE t.task_id = 'stop:' || v_stop_partial::text
         AND t.meta->>'route_stop_status' = 'partial'
         AND t.cta = 'Partial'
         AND t.tone = 'warning'
    ),
    'resolve_fieldops_tasks_v1 exposes partial status, CTA, and tone for same-context route readback'
  );

  v_resp := public.submit_fieldops_proof_v1(
    v_stop_single,
    'delivered',
    jsonb_build_object(
      'pod_methods', 'scan+photo+sig',
      'captured_at', '2026-05-26T00:00:00Z',
      'artifact_ids', jsonb_build_array(v_artifact_single, v_artifact_single_sig),
      'scan_codes', jsonb_build_array((SELECT s.tracking_number FROM public.shipments s WHERE s.id = v_ship_single)),
      'delivered_box_ids', jsonb_build_array(v_ship_single),
      'pod', jsonb_build_object('artifact_ids', jsonb_build_array(v_artifact_single, v_artifact_single_sig))
    ),
    v_idem_proof_single
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.route_stops rs
        JOIN public.shipment_boxes sb
          ON sb.shipment_id = v_ship_single
         AND sb.box_number = 1
         AND sb.status = 'delivered'
       WHERE rs.id = v_stop_single
         AND rs.metadata #>> '{proof,scan}' = 'true'
         AND rs.metadata #> '{last_proof,evidence,delivered_box_numbers}' = jsonb_build_array(1)
    ),
    'submit_fieldops_proof_v1 accepts stop-detail shipment fallback tracking code and maps it to box 1'
  );
  UPDATE public.route_runs
     SET status = 'completed',
         updated_at = now()
   WHERE id = v_run_single;
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.route_runs rr
        JOIN public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) t
          ON t.task_id = 'stop:' || v_stop_single::text
       WHERE rr.id = v_run_single
         AND rr.status = 'completed'
         AND t.meta->>'route_run_status' = 'completed'
         AND t.meta->>'route_stop_status' = 'done'
         AND t.cta = 'Done'
         AND t.tone = 'success'
    ),
    'resolve_fieldops_tasks_v1 keeps completed single-stop route visible for same-context POD readback'
  );

  v_resp := public.submit_fieldops_proof_v1(
    v_stop_fail,
    'failed',
    '{"reason_code":"recipient_unavailable","reason_label":"Recipient unavailable","captured_at":"2026-05-25T00:00:00Z"}'::jsonb,
    gen_random_uuid()
  );
  PERFORM ok(
    (v_resp ? 'decision_log_id') AND (v_resp->>'state') = 'failed' AND (v_resp->>'ok')::boolean,
    'submit_fieldops_proof_v1 failed path accepts live open stop state and returns state=failed'
  );
  PERFORM ok(
    (v_resp ? 'shipment_action_id') AND (v_resp->>'workflow_status') = 'completed',
    'submit_fieldops_proof_v1 failed path still runs canonical route-stop closeout'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipments s
       WHERE s.id = v_ship4
         AND s.status = 'delivery_failed'
    ),
    'submit_fieldops_proof_v1 failed path projects shipment exception status'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.resolve_fieldops_tasks_v1('driver', '{}'::jsonb) t
       WHERE t.task_id = 'stop:' || v_stop_fail::text
         AND t.meta->>'route_stop_status' = 'failed'
         AND t.cta = 'Failed'
         AND t.tone = 'danger'
    ),
    'resolve_fieldops_tasks_v1 exposes failed status, CTA, and tone for Route tab readback'
  );

  -- invalid: submitting against a terminal-state stop must raise P0001
  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_proof_v1(%L::uuid, %L, %L::jsonb, %L::uuid)',
           v_stop_done, 'delivered', '{}', v_idem_proof_terminal),
    'P0001'
  );

  ------------------------------------------------------------------------
  -- 2) advance_fieldops_trip_stage_v1 — happy path + invalid transition.
  ------------------------------------------------------------------------
  v_resp := public.advance_fieldops_trip_stage_v1(v_run, 'gate-in', NULL, v_idem_advance);
  PERFORM ok(
    (v_resp->>'state') = 'gate-in' AND (v_resp->>'ok')::boolean,
    'advance_fieldops_trip_stage_v1 happy path assigned -> gate-in'
  );

  -- invalid: skipping stages (gate-in -> in-transit) must raise P0001
  PERFORM throws_ok(
    format('SELECT public.advance_fieldops_trip_stage_v1(%L::uuid, %L, NULL, %L::uuid)',
           v_run, 'in-transit', v_idem_advance_skip),
    'P0001'
  );

  ------------------------------------------------------------------------
  -- 3) induct_fieldops_parcel_v1 — happy path + invalid tracking number.
  ------------------------------------------------------------------------
  v_resp := public.induct_fieldops_parcel_v1('BAY-A1', 'WB' || upper(replace(substr(v_ship::text, 1, 8), '-', '')), v_idem_induct);
  PERFORM ok(
    (v_resp->>'state') = 'inducted'
    AND (v_resp ? 'induction_id')
    AND (v_resp->>'ok')::boolean,
    'induct_fieldops_parcel_v1 happy path returns state=inducted'
  );
  v_sortation_readback := api.resolve_fieldops_sortation_v1(
    'loader',
    jsonb_build_object('organization_id', v_org)
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_sortation_readback->'recent') item
       WHERE item->>'parcel' = 'WB' || upper(replace(substr(v_ship::text, 1, 8), '-', ''))
         AND item->>'bay' = 'BAY-A1'
    ),
    'api.resolve_fieldops_sortation_v1 exposes inducted tracking number in recent readback'
  );
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_sortation_readback->'bays') item
       WHERE item->>'id' = 'BAY-A1'
         AND (item->>'count')::int >= 1
    ),
    'api.resolve_fieldops_sortation_v1 exposes active bay counts from inductions'
  );
  PERFORM is(
    (v_sortation_readback->>'inducted')::int,
    1,
    'api.resolve_fieldops_sortation_v1 counts same-window induction throughput'
  );

  -- invalid: unknown tracking_number must raise P0001
  PERFORM throws_ok(
    format('SELECT public.induct_fieldops_parcel_v1(%L, %L, gen_random_uuid())',
           'BAY-A1', 'UNKNOWN-TRACK-XYZ'),
    'P0001'
  );

  ------------------------------------------------------------------------
  -- 4) sign_fieldops_cash_drop_v1 — happy path (balanced) + invalid variance.
  ------------------------------------------------------------------------
  v_cash_drop_readback := public.resolve_fieldops_cash_drop_v1(
    'driver',
    jsonb_build_object('route_run_id', v_run)
  );
  PERFORM is(
    (v_cash_drop_readback->>'expected_sar')::int,
    43,
    'resolve_fieldops_cash_drop_v1 derives expected_sar from canonical COD payment collection'
  );

  v_resp := public.sign_fieldops_cash_drop_v1(100, 100, NULL, NULL, v_idem_cash);
  PERFORM ok(
    (v_resp->>'state') = 'balanced' AND (v_resp->>'ok')::boolean,
    'sign_fieldops_cash_drop_v1 happy path balanced state'
  );
  v_cash_drop_readback := public.resolve_fieldops_cash_drop_v1(
    'driver',
    jsonb_build_object('route_run_id', v_run)
  );
  PERFORM is(
    v_cash_drop_readback #>> '{latest_drop,decision_log_id}',
    v_resp->>'decision_log_id',
    'resolve_fieldops_cash_drop_v1 exposes latest same-driver cash-drop readback'
  );

  -- invalid: variance without supervisor/photo must raise 22023
  PERFORM throws_ok(
    format('SELECT public.sign_fieldops_cash_drop_v1(100, 80, NULL, NULL, %L::uuid)', v_idem_cash_bad),
    '22023'
  );

  ------------------------------------------------------------------------
  -- 5) request_fieldops_wallet_withdraw_v1 — happy + idempotency + invalid.
  ------------------------------------------------------------------------
  PERFORM *
    FROM public.record_finance_event_v1(jsonb_build_object(
      'organization_id', v_org,
      'event_type', 'payout',
      'direction', 'in',
      'amount', 100,
      'currency', 'SAR',
      'account_type', 'driver',
      'account_id', v_driver,
      'subject_type', 'driver_shift',
      'subject_id', v_run,
      'idempotency_key', 'pgtap-fieldops-wallet-credit-' || v_idem_wallet::text,
      'metadata', jsonb_build_object('source', 'fieldops_mobile_v2_wallet_readback_pgtap')
    ));

  v_resp := public.request_fieldops_wallet_withdraw_v1(75, v_idem_wallet);
  PERFORM ok(
    (v_resp->>'state') = 'requested'
    AND (v_resp ? 'request_id')
    AND (v_resp->>'ok')::boolean,
    'request_fieldops_wallet_withdraw_v1 happy path requested state'
  );
  v_wallet_readback := public.resolve_fieldops_wallet_v1('driver', '{}'::jsonb);
  PERFORM ok(
    v_wallet_readback #>> '{latest_withdrawal,decision_log_id}' = v_resp->>'decision_log_id'
    AND v_wallet_readback #>> '{latest_withdrawal,request_id}' = v_resp->>'request_id'
    AND v_wallet_readback #>> '{latest_withdrawal,state}' = 'requested'
    AND (v_wallet_readback #>> '{latest_withdrawal,amount_sar}')::int = 75
    AND (v_wallet_readback #>> '{wallet,balance_sar}')::int = 25,
    'resolve_fieldops_wallet_v1 exposes latest same-driver wallet withdrawal readback and available balance'
  );

  -- idempotency: same key returns same decision_log_id
  v_resp2 := public.request_fieldops_wallet_withdraw_v1(75, v_idem_wallet);
  PERFORM ok(
    (v_resp2->>'decision_log_id') = (v_resp->>'decision_log_id'),
    'request_fieldops_wallet_withdraw_v1 idempotent replay returns same decision_log_id'
  );

  -- invalid: zero amount must raise 22023
  PERFORM throws_ok(
    format('SELECT public.request_fieldops_wallet_withdraw_v1(0, %L::uuid)', v_idem_wallet_bad),
    '22023'
  );

  -- invalid: above the finance_events-backed available balance must raise 22023
  PERFORM throws_ok(
    format('SELECT public.request_fieldops_wallet_withdraw_v1(26, %L::uuid)', v_idem_wallet_overdraw),
    '22023'
  );

  ------------------------------------------------------------------------
  -- 6) submit_fieldops_hold_decision_v1 — happy + invalid (discard no note).
  ------------------------------------------------------------------------
  v_resp := public.submit_fieldops_hold_decision_v1(v_hold_id, 'reinduct', NULL, v_idem_hold);
  v_hold_readback := public.resolve_fieldops_hold_v1('loader', '{}'::jsonb);
  PERFORM ok(
    (v_resp->>'state') = 'reinduct'
    AND (v_resp->>'hold_status') = 'resolved'
    AND (v_resp->>'ok')::boolean
    AND EXISTS (
      SELECT 1
        FROM public.shipment_holds h
       WHERE h.id = v_hold_id
         AND h.organization_id = v_org
         AND h.status = 'resolved'
         AND h.resolved_at IS NOT NULL
         AND h.decision_log_id = (v_resp->>'decision_log_id')::uuid
    )
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_hold_readback) AS item(row)
       WHERE item.row->>'hold_id' = v_hold_id::text
    ),
    'submit_fieldops_hold_decision_v1 transitions hold row and resolver removes it after backend readback'
  );

  -- invalid: discard requires a non-empty note (22023)
  PERFORM throws_ok(
    format('SELECT public.submit_fieldops_hold_decision_v1(gen_random_uuid(), %L, NULL, %L::uuid)',
           'discard', v_idem_hold_bad),
    '22023'
  );

  ------------------------------------------------------------------------
  -- 7) release_fieldops_hub_pickup_v1 — happy + invalid OTP format.
  ------------------------------------------------------------------------
  v_resp := public.release_fieldops_hub_pickup_v1(v_queue_id, '123456', v_idem_pickup);
  PERFORM ok(
    (v_resp->>'state') = 'released' AND (v_resp->>'ok')::boolean,
    'release_fieldops_hub_pickup_v1 happy path released'
  );

  -- invalid: non-numeric OTP must raise 22023
  PERFORM throws_ok(
    format('SELECT public.release_fieldops_hub_pickup_v1(gen_random_uuid(), %L, %L::uuid)',
           'abc123', v_idem_pickup_bad),
    '22023'
  );

  ------------------------------------------------------------------------
  -- 8) mark_fieldops_return_received_v1 — happy + invalid (already rto).
  ------------------------------------------------------------------------
  v_resp := public.mark_fieldops_return_received_v1(v_stop_rto, v_idem_rto);
  PERFORM ok(
    (v_resp->>'state') = 'rto' AND (v_resp->>'ok')::boolean,
    'mark_fieldops_return_received_v1 happy path returns state=rto'
  );
  v_returns_readback := public.resolve_fieldops_returns_v1('driver', '{}'::jsonb);
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_returns_readback->'returned') item
       WHERE item->>'stop_id' = v_stop_rto::text
         AND item->>'id' = 'RTO-' || substr(v_stop_rto::text, 1, 8)
         AND item->>'customer' = 'RTO Customer'
         AND (item->>'parcels')::int = 2
    ),
    'resolve_fieldops_returns_v1 exposes marked RTO stop lineage for same-context readback'
  );
  PERFORM ok(
    NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_returns_readback->'failed') item
       WHERE item->>'id' = v_stop_rto::text
    ),
    'resolve_fieldops_returns_v1 removes the marked RTO stop from failed readback'
  );

  -- invalid: re-marking the same stop must raise P0001 (uses a fresh key)
  PERFORM throws_ok(
    format('SELECT public.mark_fieldops_return_received_v1(%L::uuid, gen_random_uuid())', v_stop_rto),
    'P0001'
  );

  ------------------------------------------------------------------------
  -- Reset session JWT claims.
  ------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  ------------------------------------------------------------------------
  -- Cleanup is handled by the file-level ROLLBACK. Deleting the synthetic
  -- organization here is brittle because write RPCs can create additional
  -- audit/reference rows through triggers that rightly protect FK lineage.
  ------------------------------------------------------------------------
END $$;

SELECT * FROM finish();
ROLLBACK;
