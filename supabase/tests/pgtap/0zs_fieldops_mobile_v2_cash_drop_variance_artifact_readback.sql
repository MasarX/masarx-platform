-- pgTAP: FieldOps Mobile V2 cash-drop variance requires registered envelope artifact.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

SELECT has_function(
  'public',
  'sign_fieldops_cash_drop_v1',
  ARRAY['integer','integer','text','uuid','uuid'],
  'public.sign_fieldops_cash_drop_v1 exists for cash-drop variance write'
);

SELECT has_function(
  'public',
  'resolve_fieldops_cash_drop_v1',
  ARRAY['text','jsonb'],
  'public.resolve_fieldops_cash_drop_v1 exists for cash-drop readback'
);

SELECT has_function(
  'api',
  'resolve_fieldops_cash_drop_v1',
  ARRAY['text','jsonb'],
  'api.resolve_fieldops_cash_drop_v1 exists for Mobile V2 exposed-schema clients'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_artifact UUID := gen_random_uuid();
  v_foreign_artifact UUID := gen_random_uuid();
  v_unregistered_artifact UUID := gen_random_uuid();
  v_wrong_bucket_artifact UUID := gen_random_uuid();
  v_idem_unregistered UUID := gen_random_uuid();
  v_idem_foreign UUID := gen_random_uuid();
  v_idem_wrong_bucket UUID := gen_random_uuid();
  v_idem_variance UUID := gen_random_uuid();
  v_storage_key TEXT;
  v_resp JSONB;
  v_readback JSONB;
BEGIN
  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'pgTAP Mobile V2 cash variance', 'pgt-mv2-cash-var-' || substr(v_org::text, 1, 8)),
    (v_other_org, 'pgTAP Mobile V2 cash variance other', 'pgt-mv2-cash-var-other-' || substr(v_other_org::text, 1, 8))
  ON CONFLICT DO NOTHING;

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (
    v_driver,
    v_org,
    'pgt-mv2-cash-var-' || substr(v_driver::text, 1, 8) || '@e.test',
    'Mobile V2 Cash Variance Driver',
    'fieldops_money_driver',
    'active'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Mobile V2 Cash Variance Client', 'pgt-mv2-cash-var-client-' || substr(v_client::text, 1, 8), 'active')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Mobile V2 Cash Variance Sender', 'Mobile V2 Cash Variance Sender', TRUE, 'active')
  ON CONFLICT DO NOTHING;

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:fieldops-cash-variance-fixture-bootstrap'
  );

  v_storage_key := v_org::text || '/cash-drop/envelope-' || v_artifact::text || '.jpg';

  INSERT INTO public.artifacts (
    id, organization_id, storage_bucket, storage_key, mime_type, size_bytes, created_by_user_id, source_system, metadata
  )
  VALUES
    (
      v_artifact,
      v_org,
      'fieldops-evidence',
      v_storage_key,
      'image/jpeg',
      128,
      v_driver,
      'fieldops_mobile_v2',
      jsonb_build_object('artifact_kind', 'cash_drop_envelope', 'proof_type', 'cash_drop_envelope')
    ),
    (
      v_wrong_bucket_artifact,
      v_org,
      'fieldops-pod',
      'pgtap/' || v_wrong_bucket_artifact::text || '.jpg',
      'image/jpeg',
      128,
      v_driver,
      'fieldops_mobile_v2',
      jsonb_build_object('artifact_kind', 'cash_drop_envelope', 'proof_type', 'cash_drop_envelope')
    ),
    (
      v_foreign_artifact,
      v_other_org,
      'fieldops-evidence',
      v_other_org::text || '/cash-drop/envelope-' || v_foreign_artifact::text || '.jpg',
      'image/jpeg',
      128,
      NULL,
      'fieldops_mobile_v2',
      jsonb_build_object('artifact_kind', 'cash_drop_envelope', 'proof_type', 'cash_drop_envelope')
    )
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_driver::text, 'role', 'authenticated')::text,
    true
  );

  PERFORM throws_ok(
    format(
      'SELECT public.sign_fieldops_cash_drop_v1(100, 80, %L, %L::uuid, %L::uuid)',
      'Supervisor Proof',
      v_unregistered_artifact,
      v_idem_unregistered
    ),
    '22023',
    'sign_fieldops_cash_drop_v1: variance -20 requires current-tenant registered cash-drop photo artifact',
    'cash-drop variance rejects unregistered photo artifact'
  );

  PERFORM throws_ok(
    format(
      'SELECT public.sign_fieldops_cash_drop_v1(100, 80, %L, %L::uuid, %L::uuid)',
      'Supervisor Proof',
      v_foreign_artifact,
      v_idem_foreign
    ),
    '22023',
    'sign_fieldops_cash_drop_v1: variance -20 requires current-tenant registered cash-drop photo artifact',
    'cash-drop variance rejects cross-tenant photo artifact'
  );

  PERFORM throws_ok(
    format(
      'SELECT public.sign_fieldops_cash_drop_v1(100, 80, %L, %L::uuid, %L::uuid)',
      'Supervisor Proof',
      v_wrong_bucket_artifact,
      v_idem_wrong_bucket
    ),
    '22023',
    'sign_fieldops_cash_drop_v1: variance -20 requires current-tenant registered cash-drop photo artifact',
    'cash-drop variance rejects non-envelope storage bucket'
  );

  v_resp := public.sign_fieldops_cash_drop_v1(
    100,
    80,
    'Supervisor Proof',
    v_artifact,
    v_idem_variance
  );

  PERFORM ok(
    (v_resp->>'state') = 'variance'
      AND (v_resp->>'variance_sar')::int = -20
      AND (v_resp->>'ok')::boolean,
    'cash-drop variance accepts registered current-tenant envelope artifact'
  );

  v_readback := public.resolve_fieldops_cash_drop_v1('driver', '{}'::jsonb);

  PERFORM is(
    v_readback #>> '{latest_drop,decision_log_id}',
    v_resp->>'decision_log_id',
    'cash-drop resolver exposes latest variance decision readback'
  );

  PERFORM is(
    v_readback #>> '{latest_drop,state}',
    'variance',
    'cash-drop resolver exposes variance state'
  );

  PERFORM is(
    (v_readback #>> '{latest_drop,variance_sar}')::int,
    -20,
    'cash-drop resolver exposes non-zero variance amount'
  );

  PERFORM is(
    v_readback #>> '{latest_drop,photo_id}',
    v_artifact::text,
    'cash-drop resolver exposes registered envelope photo id'
  );

  PERFORM ok(
    (v_readback #>> '{latest_drop,photo_artifact_registered}')::boolean,
    'cash-drop resolver confirms registered envelope artifact'
  );

  PERFORM is(
    v_readback #>> '{latest_drop,photo_storage_key}',
    v_storage_key,
    'cash-drop resolver exposes envelope photo storage key'
  );

  v_readback := api.resolve_fieldops_cash_drop_v1('driver', '{}'::jsonb);

  PERFORM is(
    v_readback #>> '{latest_drop,photo_id}',
    v_artifact::text,
    'api cash-drop resolver mirrors variance photo readback for Mobile V2 clients'
  );
END $$;

SELECT * FROM finish();
ROLLBACK;
