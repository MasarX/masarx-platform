-- pgTAP: FieldOps Mobile V2 hold-decision same-context readback.

SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_hold UUID := gen_random_uuid();
  v_discard_hold UUID := gen_random_uuid();
  v_idem UUID := gen_random_uuid();
  v_idem_discard UUID := gen_random_uuid();
  v_idem_repeat UUID := gen_random_uuid();
  v_before JSONB;
  v_after JSONB;
  v_resp JSONB;
  v_discard_resp JSONB;
BEGIN
  EXECUTE 'RESET ROLE';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'pgTAP mobile hold decision', 'pgt-mv2-hold-' || substr(v_org::text, 1, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (
    v_user,
    v_org,
    'pgt-mv2-hold-' || substr(v_user::text, 1, 8) || '@e.test',
    'Mobile Hold Driver',
    'fieldops_money_driver',
    'active'
  );

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'pgTAP mobile hold decision client',
    'pgt-mv2-hold-client-' || substr(v_client::text, 1, 8),
    'active'
  );

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'pgTAP mobile hold decision sender',
    'pgTAP mobile hold decision sender',
    TRUE,
    'active'
  );

  PERFORM public.bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:fieldops-mobile-hold-decision-readback-fixture-bootstrap'
  );

  INSERT INTO public.shipment_holds (
    id, organization_id, parcel_id, reported_by_user_id, severity_id, status, note, photo_storage_path
  )
  VALUES
    (v_hold, v_org, gen_random_uuid(), v_user, 'crushed', 'open', 'hold decision reinduct readback', 'hold/reinduct.jpg'),
    (v_discard_hold, v_org, gen_random_uuid(), v_user, 'destroyed', 'open', 'hold decision discard readback', 'hold/discard.jpg');

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true
  );

  v_before := api.resolve_fieldops_hold_v1('loader', '{}'::jsonb);
  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_before) AS item(row)
       WHERE item.row->>'hold_id' = v_hold::text
    ),
    'resolve_fieldops_hold_v1 exposes open hold before decision'
  );

  v_resp := api.submit_fieldops_hold_decision_v1(v_hold, 'reinduct', NULL, v_idem);
  v_after := api.resolve_fieldops_hold_v1('loader', '{}'::jsonb);

  PERFORM ok(
    (v_resp->>'ok')::boolean
    AND v_resp->>'state' = 'reinduct'
    AND v_resp->>'hold_status' = 'resolved'
    AND v_resp ? 'decision_log_id',
    'submit_fieldops_hold_decision_v1 returns resolved readback metadata'
  );

  PERFORM ok(
    NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_after) AS item(row)
       WHERE item.row->>'hold_id' = v_hold::text
    ),
    'resolve_fieldops_hold_v1 removes decided hold after backend mutation'
  );

  EXECUTE 'RESET ROLE';

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.shipment_holds h
       WHERE h.id = v_hold
         AND h.organization_id = v_org
         AND h.status = 'resolved'
         AND h.resolved_at IS NOT NULL
         AND h.decision_log_id = (v_resp->>'decision_log_id')::uuid
         AND h.metadata#>>'{latest_mobile_v2_hold_decision,action}' = 'reinduct'
    ),
    'shipment_holds carries canonical resolved status and decision metadata'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.decision_log d
       WHERE d.id = (v_resp->>'decision_log_id')::uuid
         AND d.organization_id = v_org
         AND d.decision_category = 'fieldops_hold_decision'
         AND d.resource_id = v_hold
         AND d.decision_outcome = 'reinduct'
         AND d.performed_by_system = 'fieldops_mobile_v2'
    ),
    'decision_log records Mobile V2 hold-decision lineage'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM throws_ok(
    format(
      'SELECT api.submit_fieldops_hold_decision_v1(%L::uuid, %L, NULL, %L::uuid)',
      v_hold,
      'escalate',
      v_idem_repeat
    ),
    '22023',
    NULL,
    'already decided hold rejects a second non-idempotent decision'
  );

  v_discard_resp := api.submit_fieldops_hold_decision_v1(
    v_discard_hold,
    'discard',
    'Mobile V2 discard readback pgtap note',
    v_idem_discard
  );

  EXECUTE 'RESET ROLE';

  PERFORM ok(
    v_discard_resp->>'hold_status' = 'discarded'
    AND EXISTS (
      SELECT 1
        FROM public.shipment_holds h
       WHERE h.id = v_discard_hold
         AND h.status = 'discarded'
         AND h.metadata#>>'{latest_mobile_v2_hold_decision,note}' = 'Mobile V2 discard readback pgtap note'
    ),
    'discard action requires and persists the operator note'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM throws_ok(
    format(
      'SELECT api.submit_fieldops_hold_decision_v1(%L::uuid, %L, NULL, %L::uuid)',
      gen_random_uuid(),
      'reinduct',
      gen_random_uuid()
    ),
    '42501',
    NULL,
    'unknown or cross-tenant hold is denied'
  );

  PERFORM ok(
    has_function_privilege('authenticated', 'api.submit_fieldops_hold_decision_v1(uuid,text,text,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'api.submit_fieldops_hold_decision_v1(uuid,text,text,uuid)', 'EXECUTE'),
    'api.submit_fieldops_hold_decision_v1 grants authenticated only'
  );

  PERFORM ok(
    has_function_privilege('authenticated', 'api.resolve_fieldops_hold_v1(text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'api.resolve_fieldops_hold_v1(text,jsonb)', 'EXECUTE'),
    'api.resolve_fieldops_hold_v1 grants authenticated only'
  );
END $$;

SELECT * FROM finish();
ROLLBACK;
