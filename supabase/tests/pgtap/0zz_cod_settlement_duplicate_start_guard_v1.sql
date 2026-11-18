-- pgTAP: COD settlement workflow starts fail closed unless settlement status metadata allows COD restart.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-0000000c0d51';
  v_branch UUID := '00000000-0000-0000-0000-0000000c0d52';
  v_driver UUID := '00000000-0000-0000-0000-0000000c0d53';
  v_batch UUID := '00000000-0000-0000-0000-0000000c0d54';
  v_canceled_batch UUID := '00000000-0000-0000-0000-0000000c0d56';
  v_active_run UUID := '00000000-0000-0000-0000-0000000c0d58';
  v_client UUID := '00000000-0000-0000-0000-0000000c0d59';
  v_sender UUID := '00000000-0000-0000-0000-0000000c0d5a';
  v_template UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id
    INTO v_template
    FROM public.workflow_templates
   WHERE name = 'cod_driver_shift_settlement_v2'
   LIMIT 1;

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', TRUE);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'COD Duplicate Guard Org', 'cod-duplicate-guard-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'COD Duplicate Guard Client', 'cod-duplicate-guard-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'COD Duplicate Guard Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', TRUE);
  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:cod-settlement-duplicate-start-guard-fixture-bootstrap');

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'cod-dupe', 'COD Duplicate Guard Branch', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_driver, v_org, 'cod-duplicate-guard@example.com', 'COD Duplicate Guard Driver', 'tenant')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id, subject_type, subject_id,
    status, version, metadata
  )
  VALUES (
    v_batch, v_org, 'cod', 'driver_shift', v_branch, 'driver', v_driver,
    'approved', 1,
    jsonb_build_object(
      'source', 'pgtap/cod-duplicate-guard',
      'cod_entry_id', '00000000-0000-0000-0000-0000000c0d55',
      'tracking', 'PGTAP-COD-DUPLICATE-GUARD'
    )
  )
  ON CONFLICT (id) DO UPDATE
    SET status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = now();

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id, subject_type, subject_id,
    status, version, metadata
  )
  VALUES (
    v_canceled_batch, v_org, 'cod', 'driver_shift', v_branch, 'driver', v_driver,
    'canceled', 1,
    jsonb_build_object(
      'source', 'pgtap/cod-duplicate-guard',
      'cod_entry_id', '00000000-0000-0000-0000-0000000c0d57',
      'tracking', 'PGTAP-COD-DUPLICATE-GUARD-CANCELED'
    )
  )
  ON CONFLICT (id) DO UPDATE
    SET metadata = EXCLUDED.metadata,
        updated_at = now();

  PERFORM set_config('app.workflow_run_id', v_active_run::text, true);

  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    context,
    metadata
  )
  VALUES (
    v_active_run,
    v_template,
    COALESCE(public.resolve_template_version(v_template), 1),
    'manual',
    'pending',
    jsonb_build_object(
      'workflow_run_id', v_active_run,
      'organization_id', v_org,
      'payload', jsonb_build_object(
        'organization_id', v_org,
        'cod_entry_id', '00000000-0000-0000-0000-0000000c0d58'
      )
    ),
    jsonb_build_object('source', 'pgtap/cod-duplicate-guard')
  )
  ON CONFLICT (id) DO UPDATE
    SET workflow_status = EXCLUDED.workflow_status,
        context = EXCLUDED.context,
        updated_at = now();
END $$;

SELECT has_function(
  'public',
  'assert_cod_settlement_start_allowed_v1',
  ARRAY['uuid', 'jsonb'],
  'COD settlement duplicate-start guard function exists'
);

SELECT ok(
  pg_get_functiondef('public.ui_start_workflow_run_v1(uuid,jsonb,boolean)'::regprocedure)
    LIKE '%assert_cod_settlement_start_allowed_v1%',
  'ui_start_workflow_run_v1 invokes COD duplicate-start guard before start_workflow_run'
);

SELECT ok(
  pg_get_functiondef('public.assert_cod_settlement_start_allowed_v1(uuid,jsonb)'::regprocedure)
    LIKE '%pg_advisory_xact_lock%',
  'COD duplicate-start guard serializes same-entry starts before workflow insertion'
);

SELECT is(
  (
    SELECT lv.metadata->>'allows_cod_restart'
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'settlement_status'
       AND lv.value = 'canceled'
     LIMIT 1
  ),
  'true',
  'settlement_status metadata allows canceled COD batches to be restarted'
);

SELECT throws_ok(
  $$ SELECT public.assert_cod_settlement_start_allowed_v1(
       (SELECT id FROM public.workflow_templates WHERE name = 'cod_driver_shift_settlement_v2' LIMIT 1),
       jsonb_build_object(
         'organization_id', '00000000-0000-0000-0000-0000000c0d51',
         'cod_entry_id', '00000000-0000-0000-0000-0000000c0d55'
       )
     ) $$,
  '23505',
  NULL,
  'COD settlement start is denied when a status-metadata-blocked batch already exists for the COD entry'
);

SELECT throws_ok(
  $$ SELECT public.assert_cod_settlement_start_allowed_v1(
       (SELECT id FROM public.workflow_templates WHERE name = 'cod_driver_shift_settlement_v2' LIMIT 1),
       jsonb_build_object(
         'organization_id', '00000000-0000-0000-0000-0000000c0d51',
         'cod_entry_id', '00000000-0000-0000-0000-0000000c0d58'
       )
     ) $$,
  '23505',
  NULL,
  'COD settlement start is denied when an active workflow run already exists before batch materialization'
);

SELECT lives_ok(
  $$ SELECT public.assert_cod_settlement_start_allowed_v1(
       (SELECT id FROM public.workflow_templates WHERE name = 'cod_driver_shift_settlement_v2' LIMIT 1),
       jsonb_build_object(
         'organization_id', '00000000-0000-0000-0000-0000000c0d51',
         'cod_entry_id', '00000000-0000-0000-0000-0000000c0d57'
       )
     ) $$,
  'COD settlement start is allowed again after the prior batch is canceled'
);

SELECT * FROM finish();

ROLLBACK;
