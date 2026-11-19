-- pgTAP: FieldOps Mobile V2 settlement ledger resolver/readback.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

SELECT has_function(
  'public',
  'resolve_fieldops_settlements_v1',
  ARRAY['text', 'jsonb'],
  'public.resolve_fieldops_settlements_v1 exists'
);

SELECT has_function(
  'api',
  'resolve_fieldops_settlements_v1',
  ARRAY['text', 'jsonb'],
  'api.resolve_fieldops_settlements_v1 wrapper exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_fieldops_settlements_v1'
      AND p.prosecdef IS TRUE
      AND p.provolatile = 's'
  ),
  'public resolver is SECURITY DEFINER and STABLE'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.resolve_fieldops_settlements_v1(text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.resolve_fieldops_settlements_v1(text,jsonb)', 'EXECUTE'),
  'api resolver grants authenticated only'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_other_driver UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_batch UUID := gen_random_uuid();
  v_other_batch UUID := gen_random_uuid();
  v_resp JSONB;
  v_row JSONB;
BEGIN
  EXECUTE 'RESET ROLE';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'pgTAP Mobile V2 settlement', 'pgt-mv2-settlement-' || substr(v_org::text, 1, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES
    (
      v_driver,
      v_org,
      'pgt-mv2-settlement-driver-' || substr(v_driver::text, 1, 8) || '@e.test',
      'Mobile Settlement Driver',
      'fieldops_money_driver',
      'active'
    ),
    (
      v_other_driver,
      v_org,
      'pgt-mv2-settlement-other-' || substr(v_other_driver::text, 1, 8) || '@e.test',
      'Other Settlement Driver',
      'fieldops_money_driver',
      'active'
    );

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'pgTAP Mobile V2 settlement client',
    'pgt-mv2-settlement-client-' || substr(v_client::text, 1, 8),
    'active'
  );

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'pgTAP Mobile V2 settlement sender',
    'pgTAP Mobile V2 settlement sender',
    TRUE,
    'active'
  );

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:fieldops-mobile-settlement-readback-fixture-bootstrap'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_driver, r.id, v_driver, jsonb_build_object('source', 'fieldops_mobile_v2_settlement_pgtap')
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.settlement_batches (
    id,
    organization_id,
    kind,
    scope_type,
    subject_type,
    subject_id,
    window_start_at,
    window_end_at,
    status,
    version,
    metadata
  )
  VALUES
    (
      v_batch,
      v_org,
      'cod',
      'driver_shift',
      'driver',
      v_driver,
      now() - interval '2 hours',
      now(),
      'locked',
      1,
      jsonb_build_object(
        'title', 'pgTAP driver shift settlement',
        'currency', 'SAR',
        'expected_amount', 900,
        'collected_amount', 875,
        'payment_collection_summary', jsonb_build_object('remitted_amount', 875)
      )
    ),
    (
      v_other_batch,
      v_org,
      'cod',
      'driver_shift',
      'driver',
      v_other_driver,
      now() - interval '2 hours',
      now(),
      'locked',
      1,
      jsonb_build_object(
        'title', 'pgTAP other driver settlement',
        'currency', 'SAR',
        'expected_amount', 700,
        'collected_amount', 700,
        'payment_collection_summary', jsonb_build_object('remitted_amount', 700)
      )
    );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver::text, 'role', 'authenticated')::text,
    true
  );

  v_resp := api.resolve_fieldops_settlements_v1('driver', jsonb_build_object('limit', 10));

  PERFORM ok(
    v_resp ? 'settlements'
    AND v_resp ? 'summary'
    AND v_resp ? 'readback',
    'resolver returns settlements, summary, and readback blocks'
  );

  PERFORM is(
    jsonb_array_length(v_resp->'settlements'),
    1,
    'resolver returns only batches visible to the authenticated driver'
  );

  v_row := v_resp->'settlements'->0;

  PERFORM is(
    v_row->>'id',
    v_batch::text,
    'resolver exposes the driver subject settlement batch'
  );

  PERFORM is(
    v_row->>'status',
    'locked',
    'resolver projects settlement status'
  );

  PERFORM is(
    v_row->>'expected_amount',
    '900',
    'resolver projects expected amount from canonical summary view'
  );

  PERFORM is(
    v_row->>'remitted_amount',
    '875',
    'resolver projects remitted amount from settlement summary metadata'
  );

  PERFORM is(
    v_row->>'variance_amount',
    '-25',
    'resolver projects collected-minus-expected variance'
  );

  PERFORM is(
    v_resp#>>'{summary,count}',
    '1',
    'summary count matches visible rows'
  );

  PERFORM is(
    v_resp#>>'{readback,source}',
    'resolve_fieldops_settlements_v1',
    'readback source identifies the resolver'
  );
END $$;

SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{}'::text, true);

SELECT throws_ok(
  $$ SELECT api.resolve_fieldops_settlements_v1('driver', '{}'::jsonb) $$,
  '42501',
  NULL,
  'resolver fails closed without authenticated org context'
);

SELECT * FROM finish();
ROLLBACK;
