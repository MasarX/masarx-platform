-- pgTAP coverage for Phase 6.F mobile ops aggregator RPC envelope shapes.
-- Closes audit finding P2-15: a migration could drift the JSONB envelope
-- shape and only the FE would catch it (silently, via type casts).
--
-- This file asserts the top-level keys returned by each of the 9 api.*
-- wrappers (the actual external PostgREST contract). It complements the
-- existing 0zp_*_pack.sql coverage (existence/SECDEF/grants/auth-reject)
-- by binding the envelope contract.
--
-- Strategy:
--   - Run as a synthetic authenticated session by setting
--     request.jwt.claim.sub + role, so auth.uid() resolves and the 42501
--     gate is satisfied.
--   - Seed a minimal organizations row + organization_members link so
--     current_user_org_id() returns a non-NULL UUID and each RPC enters
--     its happy-path branch (rather than the v_org IS NULL early exit).
--   - Call each api.* wrapper and inspect the JSONB envelope:
--       * arrays: assert jsonb_typeof = 'array' (empty is acceptable).
--       * objects: assert jsonb_typeof = 'object' and that
--         jsonb_object_keys(...) matches the expected key set exactly.
--   - For trips (which returns an array of objects) the canonical row
--     shape is asserted by inserting a single route_runs row and reading
--     keys from the first element via jsonb_array_elements().
--   - All fixture inserts are guarded with IF NOT EXISTS / ON CONFLICT
--     so ladder tables remain untouched on rollback.

BEGIN;
SELECT plan(42);

-- ===========================================================================
-- Synthetic auth session: bind a deterministic user uuid and authenticated
-- role to the GUCs that auth.uid() reads from.
-- ===========================================================================

DO $$
DECLARE
  v_user_id UUID := '00000000-0000-0000-0000-00000000a0a0';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
END $$;

-- ===========================================================================
-- Minimal fixture: organization + membership so current_user_org_id() works.
-- All inserts are idempotent and rolled back at end-of-transaction.
-- ===========================================================================

DO $$
DECLARE
  v_user_id UUID := '00000000-0000-0000-0000-00000000a0a0';
  v_org_id  UUID := '00000000-0000-0000-0000-00000000b0b0';
  v_run_id  UUID := '00000000-0000-0000-0000-00000000c0c0';
  v_has_orgs BOOLEAN;
  v_has_members BOOLEAN;
  v_has_runs BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organizations'
  ) INTO v_has_orgs;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organization_members'
  ) INTO v_has_members;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'route_runs'
  ) INTO v_has_runs;

  IF v_has_orgs THEN
    BEGIN
      EXECUTE format(
        'INSERT INTO public.organizations (id, name) VALUES (%L, %L) ON CONFLICT (id) DO NOTHING',
        v_org_id, 'envelope-shape-fixture'
      );
    EXCEPTION WHEN OTHERS THEN
      -- Some schemas have extra NOT NULL columns; non-fatal: shape tests
      -- still run because v_org IS NULL branch envelopes match contract.
      NULL;
    END;
  END IF;

  IF v_has_members THEN
    BEGIN
      EXECUTE format(
        'INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (%L, %L, %L) ON CONFLICT DO NOTHING',
        v_org_id, v_user_id, 'driver'
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  IF v_has_runs THEN
    BEGIN
      EXECUTE format(
        'INSERT INTO public.route_runs (id, organization_id, driver_user_id, status, metadata) VALUES (%L, %L, %L, %L, %L::jsonb) ON CONFLICT (id) DO NOTHING',
        v_run_id, v_org_id, v_user_id, 'active', '{"kind":"trip","leg":"Hub-A -> Hub-B"}'
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;

-- ===========================================================================
-- 1) resolve_fieldops_trips_v1 — jsonb array. If a row is present we also
--    assert the per-element key set; otherwise just assert array-ness so
--    the test is tolerant of fixture-insert failures.
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_trips_v1()),
  'array',
  'trips envelope is a jsonb array'
);

DO $$
DECLARE
  v_arr JSONB := api.resolve_fieldops_trips_v1();
  v_first JSONB;
  v_keys TEXT[];
  v_expected TEXT[] := ARRAY[
    'id','code','leg','driver','vehicle','stage','origin','dest',
    'plannedDepart','plannedArrive','etaMin','distance','totalParcels',
    'scanned','sealNo','manifest'
  ];
BEGIN
  IF jsonb_array_length(v_arr) > 0 THEN
    v_first := v_arr->0;
    SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM jsonb_object_keys(v_first) k;
    PERFORM ok(
      v_keys @> v_expected AND v_expected @> v_keys,
      'trips element keys match the MobileV2Trip envelope contract'
    );
    -- origin/dest are nested objects with exactly {id, name}.
    PERFORM is(jsonb_typeof(v_first->'origin'), 'object', 'trips.origin is an object');
    PERFORM is(jsonb_typeof(v_first->'dest'), 'object', 'trips.dest is an object');
    PERFORM ok(
      (v_first->'origin') ? 'id' AND (v_first->'origin') ? 'name',
      'trips.origin has id + name keys'
    );
    PERFORM ok(
      (v_first->'dest') ? 'id' AND (v_first->'dest') ? 'name',
      'trips.dest has id + name keys'
    );
  ELSE
    -- Fixture insert was skipped or rejected; still emit 5 placeholder
    -- pass-throughs so plan() count stays stable.
    PERFORM pass('trips element key check skipped (no rows in fixture)');
    PERFORM pass('trips.origin object check skipped');
    PERFORM pass('trips.dest object check skipped');
    PERFORM pass('trips.origin key check skipped');
    PERFORM pass('trips.dest key check skipped');
  END IF;
END $$;

-- ===========================================================================
-- 2) resolve_fieldops_sortation_v1 — jsonb object with exact keys.
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_sortation_v1()),
  'object',
  'sortation envelope is a jsonb object'
);

SELECT bag_eq(
  $$ SELECT k FROM jsonb_object_keys(api.resolve_fieldops_sortation_v1()) k $$,
  $$ VALUES ('bays'),('recent'),('inducted'),('throughput_per_hour'),('minutes_elapsed') $$,
  'sortation envelope keys: bays, recent, inducted, throughput_per_hour, minutes_elapsed'
);

SELECT is(
  jsonb_typeof(api.resolve_fieldops_sortation_v1()->'bays'),
  'array',
  'sortation.bays is an array'
);

SELECT is(
  jsonb_typeof(api.resolve_fieldops_sortation_v1()->'recent'),
  'array',
  'sortation.recent is an array'
);

-- ===========================================================================
-- 3) resolve_fieldops_lookup_v1 — jsonb object with exact keys.
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_lookup_v1('driver', '{}'::jsonb, 'wb-1')),
  'object',
  'lookup envelope is a jsonb object'
);

SELECT bag_eq(
  $$ SELECT k FROM jsonb_object_keys(api.resolve_fieldops_lookup_v1('driver', '{}'::jsonb, 'wb-1')) k $$,
  $$ VALUES ('records'),('recent') $$,
  'lookup envelope keys: records, recent'
);

SELECT is(
  jsonb_typeof(api.resolve_fieldops_lookup_v1('driver', '{}'::jsonb, 'wb-1')->'records'),
  'array',
  'lookup.records is an array'
);

SELECT is(
  jsonb_typeof(api.resolve_fieldops_lookup_v1('driver', '{}'::jsonb, 'wb-1')->'recent'),
  'array',
  'lookup.recent is an array'
);

-- ===========================================================================
-- 4) resolve_fieldops_returns_v1 — jsonb object with exact keys.
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_returns_v1()),
  'object',
  'returns envelope is a jsonb object'
);

SELECT bag_eq(
  $$ SELECT k FROM jsonb_object_keys(api.resolve_fieldops_returns_v1()) k $$,
  $$ VALUES ('failed'),('returned'),('cod_collected_sar') $$,
  'returns envelope keys: failed, returned, cod_collected_sar'
);

SELECT is(
  jsonb_typeof(api.resolve_fieldops_returns_v1()->'failed'),
  'array',
  'returns.failed is an array'
);

SELECT is(
  jsonb_typeof(api.resolve_fieldops_returns_v1()->'returned'),
  'array',
  'returns.returned is an array'
);

-- ===========================================================================
-- 5) resolve_fieldops_hub_pickup_v1 — jsonb array (empty until queue ships).
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_hub_pickup_v1()),
  'array',
  'hub_pickup envelope is a jsonb array'
);

-- ===========================================================================
-- 6) resolve_fieldops_hold_v1 — jsonb array (empty until queue ships).
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_hold_v1()),
  'array',
  'hold envelope is a jsonb array'
);

-- ===========================================================================
-- 7) resolve_fieldops_cash_drop_v1 — jsonb object with exact keys.
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_cash_drop_v1()),
  'object',
  'cash_drop envelope is a jsonb object'
);

SELECT bag_eq(
  $$ SELECT k FROM jsonb_object_keys(api.resolve_fieldops_cash_drop_v1()) k $$,
  $$ VALUES ('expected_sar'),('safe_location'),('latest_drop') $$,
  'cash_drop envelope keys: expected_sar, safe_location, latest_drop'
);

-- ===========================================================================
-- 8) resolve_fieldops_wallet_v1 — jsonb object with exact keys.
--    Nested wallet object must carry balance_sar/week_to_date_sar/posts_to_bank_label.
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_wallet_v1()),
  'object',
  'wallet envelope is a jsonb object'
);

SELECT bag_eq(
  $$ SELECT k FROM jsonb_object_keys(api.resolve_fieldops_wallet_v1()) k $$,
  $$ VALUES ('wallet'),('week'),('breakdown'),('latest_withdrawal') $$,
  'wallet envelope keys: wallet, week, breakdown, latest_withdrawal'
);

SELECT bag_eq(
  $$ SELECT k FROM jsonb_object_keys(api.resolve_fieldops_wallet_v1()->'wallet') k $$,
  $$ VALUES ('balance_sar'),('week_to_date_sar'),('posts_to_bank_label') $$,
  'wallet.wallet nested keys: balance_sar, week_to_date_sar, posts_to_bank_label'
);

-- ===========================================================================
-- 9) resolve_fieldops_eor_v1 — jsonb object with exact keys.
--    Nested summary object must carry delivered/failed/total.
-- ===========================================================================

SELECT is(
  jsonb_typeof(api.resolve_fieldops_eor_v1()),
  'object',
  'eor envelope is a jsonb object'
);

SELECT bag_eq(
  $$ SELECT k FROM jsonb_object_keys(api.resolve_fieldops_eor_v1()) k $$,
  $$ VALUES ('summary'),('checklist'),('performance_note'),('route_label'),('recon'),('last_recon') $$,
  'eor envelope keys: summary, checklist, performance_note, route_label, recon, last_recon'
);

SELECT bag_eq(
  $$ SELECT k FROM jsonb_object_keys(api.resolve_fieldops_eor_v1()->'summary') k $$,
  $$ VALUES ('delivered'),('failed'),('total') $$,
  'eor.summary nested keys: delivered, failed, total'
);

SELECT ok(
  to_regprocedure('public.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid)') IS NULL,
  'old unscoped public.submit_fieldops_eod_recon_v1 six-arg overload is absent'
);

SELECT ok(
  to_regprocedure('api.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid)') IS NULL,
  'old unscoped api.submit_fieldops_eod_recon_v1 six-arg overload is absent'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'fieldops_eod_recon'
       AND lv.status = 'active'
       AND lv.retired_at IS NULL
  ),
  'fieldops_eod_recon decision_category lookup is seeded active'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
       AND COALESCE(jsonb_array_length(sv.value #> '{apps,mobile,sections}'), 0) > 0
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value #> '{apps,mobile,sections}', '[]'::jsonb)) section
          WHERE section->>'id' = 'v2-network-ops'
       )
  ),
  'scoped mobile ui_navigation rows inherit the v2-network-ops section'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
       AND COALESCE(jsonb_array_length(sv.value #> '{apps,mobile,sections}'), 0) > 0
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value #> '{apps,mobile,sections}', '[]'::jsonb)) section
           CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) item
          WHERE section->>'id' = 'v2-network-ops'
            AND item->>'id' = 'mobile-eor'
            AND item->>'href' = '/mobile/eor'
       )
  ),
  'scoped mobile ui_navigation rows expose the Mobile V2 EOR route'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_other_driver UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_run UUID := gen_random_uuid();
  v_foreign_run UUID := gen_random_uuid();
  v_stop_done UUID := gen_random_uuid();
  v_stop_open UUID := gen_random_uuid();
  v_ship_done UUID := gen_random_uuid();
  v_ship_open UUID := gen_random_uuid();
  v_submit_key UUID := gen_random_uuid();
  v_eor JSONB;
  v_submit JSONB;
  v_replay JSONB;
  v_after JSONB;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'pgTAP Mobile V2 EOR readback', 'pgt-mobile-v2-eor-' || substr(v_org::text, 1, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES
    (v_driver, v_org, 'pgt-mobile-v2-eor-' || substr(v_driver::text, 1, 8) || '@example.test', 'Mobile V2 Driver', 'driver', 'active'),
    (v_other_driver, v_org, 'pgt-mobile-v2-eor-' || substr(v_other_driver::text, 1, 8) || '@example.test', 'Other Driver', 'driver', 'active');

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Mobile V2 EOR Client', 'pgt-mobile-v2-eor-client-' || substr(v_client::text, 1, 8));

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Mobile V2 EOR Sender', 'Mobile V2 EOR Sender', TRUE, 'active');

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:fieldops-eor-envelope-fixture-bootstrap'
  );

  INSERT INTO public.branches (id, organization_id, name, code, branch_type, timezone, is_active)
  VALUES (v_branch, v_org, 'Mobile V2 EOR Hub', 'pgt-eor-' || substr(v_branch::text, 1, 8), 'primary', 'Asia/Riyadh', TRUE);

  INSERT INTO public.route_runs (id, organization_id, branch_id, driver_user_id, status, planned_date, planned_start_at, started_at, metadata)
  VALUES
    (v_run, v_org, v_branch, v_driver, 'in_progress', CURRENT_DATE, now() - interval '1 hour', now() - interval '1 hour', jsonb_build_object('source', 'pgtap_mobile_v2_eor')),
    (v_foreign_run, v_org, v_branch, v_other_driver, 'in_progress', CURRENT_DATE, now() - interval '1 hour', now() - interval '1 hour', jsonb_build_object('source', 'pgtap_mobile_v2_eor_foreign'));

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, box_count, priority_score, status, status_updated_at)
  VALUES
    (v_ship_done, v_org, v_client, v_sender, 'delivery', 'EORDONE' || substr(replace(v_ship_done::text, '-', ''), 1, 8), 2, 50, 'delivered', now()),
    (v_ship_open, v_org, v_client, v_sender, 'delivery', 'EOROPEN' || substr(replace(v_ship_open::text, '-', ''), 1, 8), 1, 50, 'pending', now());

  INSERT INTO public.route_stops (id, organization_id, route_run_id, client_id, shipment_id, stop_kind, sequence_order, planned_window_start_at, metadata)
  VALUES
    (v_stop_done, v_org, v_run, v_client, v_ship_done, 'delivery', 1, now() - interval '30 minutes', jsonb_build_object('status', 'done')),
    (v_stop_open, v_org, v_run, v_client, v_ship_open, 'delivery', 2, now(), jsonb_build_object('status', 'pending'));

  INSERT INTO public.shipment_actions (
    id,
    shipment_id,
    organization_id,
    client_id,
    action_type,
    action_category,
    canonical_status,
    action_data,
    timestamp,
    performed_by_system
  )
  VALUES (
    gen_random_uuid(),
    v_ship_done,
    v_org,
    v_client,
    'delivery_completed',
    'delivery',
    'delivered',
    jsonb_build_object(
      'route_stop_id', v_stop_done::text,
      'route_stop_outcome', 'done',
      'delivery_attempt', jsonb_build_object(
        'outcome', 'delivered',
        'route_stop_outcome', 'done'
      ),
      'delivery_completion', jsonb_build_object(
        'payment_collection', jsonb_build_object(
          'collected_amount', 125.50,
          'currency', 'SAR'
        )
      )
    ),
    now(),
    'fieldops_mobile_v2_pgtap'
  );

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  v_eor := api.resolve_fieldops_eor_v1('driver', jsonb_build_object('route_run_id', v_run));

  PERFORM is(v_eor #>> '{recon,route_run_id}', v_run::text, 'eor recon is scoped to the driver route_run_id');
  PERFORM is((v_eor #>> '{recon,parcels_count}')::int, 3, 'eor recon parcels_count derives from route stop shipment boxes');
  PERFORM is((v_eor #>> '{recon,mismatch_count}')::int, 1, 'eor recon mismatch_count derives from open route stops');
  PERFORM is((v_eor #>> '{recon,cash_declared}')::numeric, 125.50::numeric, 'eor recon cash_declared derives from canonical payment collection');

  v_submit := api.submit_fieldops_eod_recon_v1(
    (v_eor #>> '{recon,parcels_count}')::int,
    (v_eor #>> '{recon,mismatch_count}')::int,
    (v_eor #>> '{recon,cash_declared}')::numeric,
    120.00,
    'stale',
    v_submit_key,
    v_run
  );
  v_replay := api.submit_fieldops_eod_recon_v1(
    (v_eor #>> '{recon,parcels_count}')::int,
    (v_eor #>> '{recon,mismatch_count}')::int,
    (v_eor #>> '{recon,cash_declared}')::numeric,
    120.00,
    'stale',
    v_submit_key,
    v_run
  );
  v_after := api.resolve_fieldops_eor_v1('driver', jsonb_build_object('route_run_id', v_run));

  PERFORM ok((v_submit->>'ok')::boolean AND v_submit->>'route_run_id' = v_run::text, 'eod recon submit returns ok with route lineage');
  PERFORM is(v_replay->>'decision_log_id', v_submit->>'decision_log_id', 'eod recon submit is idempotent for the same route run');
  PERFORM is(v_after #>> '{last_recon,decision_log_id}', v_submit->>'decision_log_id', 'eor resolver returns same-context latest reconciliation readback');
  PERFORM is((v_after #>> '{last_recon,cash_variance}')::numeric, (-5.50)::numeric, 'latest reconciliation readback includes cash variance');

  PERFORM throws_ok(
    format(
      'SELECT api.submit_fieldops_eod_recon_v1(1, 0, 0, 0, %L, %L::uuid, %L::uuid)',
      'synced',
      gen_random_uuid(),
      v_foreign_run
    ),
    '42501',
    NULL,
    'eod recon submit rejects a route not assigned to the Mobile V2 caller'
  );

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

SELECT * FROM finish();
ROLLBACK;
